/**
 * FileViewer — shared read-only file viewer for the mobile shell.
 *
 * Text files render through the shared Markdown fenced-code path (shiki
 * highlighting, zero new deps); images render inline via the binary-read
 * path. Extracted from MobileFilesScreen so the chat-stream viewer overlay
 * (MobileViewerOverlay) can reuse the exact same rendering.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { IconArrowUp, IconLoader2, IconPhoto } from "@renderer/lib/icons.js";

/** File extension → shiki language id for the fenced-code renderer. */
export const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", go: "go", rs: "rust", java: "java", c: "c",
  h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", sh: "bash",
  bash: "bash", yml: "yaml", yaml: "yaml", toml: "toml", html: "html", htm: "html",
  css: "css", scss: "scss", sql: "sql", xml: "xml", svg: "xml", vue: "vue", kt: "kotlin",
  swift: "swift", dockerfile: "docker", env: "ini", ini: "ini", txt: "text", log: "text",
};

/** Image extensions rendered inline via the binary-read path. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

/** Full-screen read-only file viewer with its own header (used by the
 *  MobileFilesScreen browser). */
export function FileViewerOverlay({
  name,
  path,
  onClose,
}: {
  name: string;
  path: string;
  onClose: () => void;
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
      <FileViewerContent name={name} path={path} />
    </div>
  );
}

/** Body-only variant (loading / image / failed / text) — embedded by overlays
 *  that render their own header. */
export function FileViewerContent({ name, path }: { name: string; path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ext = extOf(name);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setImageUrl(null);
    setFailed(false);
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

  const lang = LANG_BY_EXT[ext] ?? "text";
  const markdown = content === null ? "" : `\`\`\`${lang}\n${content}\n\`\`\``;

  if (imageUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-4">
        <img src={imageUrl} alt={name} className="max-h-full max-w-full object-contain" />
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
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      <Markdown>{markdown}</Markdown>
    </div>
  );
}
