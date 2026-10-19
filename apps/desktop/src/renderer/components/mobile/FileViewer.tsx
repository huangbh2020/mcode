/**
 * FileViewer — shared read-only file viewer for the mobile shell.
 *
 * Text files render through the shared Markdown fenced-code path (shiki
 * highlighting, zero new deps); markdown files default to the rendered
 * preview instead (same shared Markdown component, raw content) with a
 * floating pill to flip back to the highlighted source; images render
 * inline via the binary-read path. Extracted from MobileFilesScreen so the
 * chat-stream viewer overlay (MobileViewerOverlay) can reuse the exact same
 * rendering.
 *
 * Image gallery: when `onNavigate` is provided (hosts that can re-point
 * their viewer state), the image branch lists the containing directory via
 * the same guarded `file.listDir` the files screen uses and offers prev/
 * next stepping through sibling images — chevron buttons, a position
 * counter, and horizontal touch swipes. The HOST stays the source of truth:
 * each step calls `onNavigate` with the new file so headers/titles follow.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { basename, dirname, relativePath } from "@renderer/lib/path.js";
import { useScrollMemory } from "@renderer/lib/scrollMemory.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import {
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconEye,
  IconLoader2,
  IconPhoto,
} from "@renderer/lib/icons.js";

/** File extension → shiki language id for the fenced-code renderer. */
export const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", markdown: "markdown", py: "python", go: "go", rs: "rust", java: "java", c: "c",
  h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", sh: "bash",
  bash: "bash", yml: "yaml", yaml: "yaml", toml: "toml", html: "html", htm: "html",
  css: "css", scss: "scss", sql: "sql", xml: "xml", svg: "xml", vue: "vue", kt: "kotlin",
  swift: "swift", dockerfile: "docker", env: "ini", ini: "ini", txt: "text", log: "text",
};

/** Image extensions rendered inline via the binary-read path. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

/** Markdown extensions that default to the rendered preview view (mirrors
 *  the desktop editor's isMarkdown gate). */
const MARKDOWN_EXT = new Set(["md", "markdown"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

/** Comparison key for matching a `file.listDir` entry path against the
 *  viewed file's path — producers differ in drive-letter casing and `\\` vs
 *  `/`, so compare normalized + case-insensitive (same trick as the desktop
 *  pane's imagePathKey). */
function galleryKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Pick the workspace root (a project or the active session's worktree)
 *  that contains `filePath` — longest prefix wins. `file.listDir` only
 *  accepts known workspace roots, and a chat file link can point at the main
 *  checkout while the active session browses a worktree (or vice versa), so
 *  every candidate root is considered. Returns null when the file sits
 *  outside all of them (no gallery chrome). */
function galleryRootFor(filePath: string, candidates: string[]): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const key = norm(filePath);
  let best: string | null = null;
  let bestLen = -1;
  for (const c of candidates) {
    if (!c) continue;
    const n = norm(c);
    if (key === n || key.startsWith(n + "/")) {
      if (n.length > bestLen) {
        best = c;
        bestLen = n.length;
      }
    }
  }
  return best;
}

/** Full-screen read-only file viewer with its own header (used by the
 *  MobileFilesScreen browser). */
export function FileViewerOverlay({
  name,
  path,
  onClose,
  onNavigate,
}: {
  name: string;
  path: string;
  onClose: () => void;
  /** Optional: enables prev/next sibling-image stepping (host re-points its
   *  viewer state at the stepped file). Keep the identity stable — the
   *  gallery effect keys on it. */
  onNavigate?: (entry: { name: string; path: string }) => void;
}) {
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
          {name}
        </div>
        <span className="w-12" />
      </div>
      <FileViewerContent name={name} path={path} onNavigate={onNavigate} />
    </div>
  );
}

/** Body-only variant (loading / image / failed / text) — embedded by overlays
 *  that render their own header. Markdown files open in the rendered preview
 *  by default; the floating pill toggles to the shiki-highlighted source. */
export function FileViewerContent({
  name,
  path,
  onNavigate,
}: {
  name: string;
  path: string;
  /** Optional: enables prev/next sibling-image stepping. Absent → no gallery
   *  chrome (e.g. the diff-fallback view, which has no file state to step). */
  onNavigate?: (entry: { name: string; path: string }) => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [sourceView, setSourceView] = useState(false);
  const ext = extOf(name);
  const isMd = MARKDOWN_EXT.has(ext);
  // The overlay unmounts when the user taps 返回, so without a remembered
  // offset tapping the same file again landed back at the top. Rendered
  // preview and highlighted source are different renderings of the same file
  // (and scroll by different amounts) — each keeps its own position, mirroring
  // the desktop's preview/edit split. The image branch needs none: the image is
  // scaled to fit, so its container cannot scroll.
  const scrollRef = useScrollMemory(
    `${isMd && !sourceView ? "mobile-md" : "mobile-source"}:${path}`,
  );

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setImageUrl(null);
    setFailed(false);
    setSourceView(false);
    if (IMAGE_EXT.has(ext)) {
      void api.file
        .readBinary({ filePath: path })
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
        .readFile({ filePath: path })
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
  }, [path, ext]);

  /* ── sibling-image gallery (mirrors the desktop editor's pane) ── */
  // null = listing unavailable; empty = no siblings → no chrome. Refetches on
  // every step (the host re-points `path`), which also keeps the counter in
  // sync with any on-disk changes.
  const envPath = useSessionStore(selectActiveEnvPath);
  const projects = useSessionStore((s) => s.projects);
  const [siblings, setSiblings] = useState<string[] | null>(null);
  useEffect(() => {
    if (!onNavigate || !IMAGE_EXT.has(ext)) {
      setSiblings(null);
      return;
    }
    let cancelled = false;
    setSiblings(null);
    const root = galleryRootFor(path, [envPath ?? "", ...projects.map((p) => p.path)]);
    if (!root) return;
    const rel = relativePath(dirname(path), root);
    api.file
      .listDir({ projectPath: root, dirPath: rel })
      .then(({ entries }) => {
        if (cancelled) return;
        setSiblings(
          entries.filter((e) => !e.isDir && IMAGE_EXT.has(extOf(e.name))).map((e) => e.path),
        );
      })
      .catch(() => {
        if (!cancelled) setSiblings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path, ext, onNavigate, envPath, projects]);

  // Touch-swipe anchor for the gallery (horizontal fling = prev/next). Lives
  // at the top level — hooks can't sit behind the image early-return below.
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const lang = LANG_BY_EXT[ext] ?? "text";
  const markdown = content === null ? "" : `\`\`\`${lang}\n${content}\n\`\`\``;

  if (imageUrl) {
    const gallery = siblings != null && siblings.length > 1 ? siblings : null;
    const idx = gallery
      ? gallery.findIndex((p) => galleryKey(p) === galleryKey(path))
      : -1;
    const step = (delta: number) => {
      if (!gallery || idx < 0 || !onNavigate) return;
      const next = gallery[idx + delta];
      if (!next) return;
      onNavigate({ name: basename(next), path: next });
    };
    const prevLabel = t("ide.editor.imagePrev");
    const nextLabel = t("ide.editor.imageNext");
    return (
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-4"
        onTouchStart={
          gallery && idx >= 0
            ? (e) => {
                const touch = e.touches[0];
                touchStart.current = { x: touch.clientX, y: touch.clientY };
              }
            : undefined
        }
        onTouchEnd={
          gallery && idx >= 0
            ? (e) => {
                const start = touchStart.current;
                touchStart.current = null;
                if (!start) return;
                const touch = e.changedTouches[0];
                const dx = touch.clientX - start.x;
                const dy = touch.clientY - start.y;
                // Horizontal-dominant fling only: the fit-scaled image never
                // scrolls sideways, and requiring |dx| ≥ 2·|dy| keeps a
                // vertical scroll gesture from ever paging the gallery.
                if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 2) return;
                step(dx < 0 ? 1 : -1);
              }
            : undefined
        }
      >
        <img src={imageUrl} alt={name} className="max-h-full max-w-full object-contain" />
        {gallery && idx >= 0 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={idx <= 0}
              aria-label={prevLabel}
              className="absolute left-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-edge bg-surface-muted/90 text-content-muted shadow-lg backdrop-blur active:bg-surface-hover disabled:pointer-events-none disabled:opacity-30"
            >
              <IconChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={idx >= gallery.length - 1}
              aria-label={nextLabel}
              className="absolute right-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-edge bg-surface-muted/90 text-content-muted shadow-lg backdrop-blur active:bg-surface-hover disabled:pointer-events-none disabled:opacity-30"
            >
              <IconChevronRight size={17} />
            </button>
            <span className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-edge bg-surface-muted/90 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-content-muted shadow-lg backdrop-blur">
              {idx + 1} / {gallery.length}
            </span>
          </>
        )}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center gap-1.5 text-xs text-content-subtle">
        <IconPhoto size={14} /> 无法预览此文件
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-content-subtle">
        <IconLoader2 size={16} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="absolute inset-0 overflow-auto px-3 py-2">
        <Markdown baseDir={dirname(path)}>{isMd && !sourceView ? content : markdown}</Markdown>
      </div>
      {isMd && (
        <button
          type="button"
          onClick={() => setSourceView((v) => !v)}
          title={sourceView ? t("ide.viewer.mdPreview") : t("ide.viewer.mdSource")}
          className="absolute bottom-4 right-4 z-10 flex h-8 items-center gap-1.5 rounded-full border border-edge bg-surface-muted/90 px-3 text-xs text-content-muted shadow-lg backdrop-blur hover:bg-surface-hover active:bg-surface-hover"
        >
          {sourceView ? <IconEye size={14} /> : <IconCode size={14} />}
          {sourceView ? t("ide.viewer.mdPreview") : t("ide.viewer.mdSource")}
        </button>
      )}
    </div>
  );
}
