/**
 * MobileViewerOverlay — the mobile shell's fullscreen viewer for chat-stream
 * content the desktop shows in its Electron-only panes:
 *  - file: a read-only file (FileLink taps / mobile files browsing)
 *  - diff: a turn's file change — frozen `before` snapshot vs current disk
 *  - plan: plan markdown (PlanStreamBlock "查看计划" taps)
 *
 * Driven by `mobileViewer` in the session store; only the AppMobile shell
 * renders this component, so the desktop is unaffected.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { basename } from "@renderer/lib/path.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { DiffView } from "@renderer/components/chat/DiffView.js";
import { lineDiff } from "@renderer/lib/lineDiff.js";
import { FileViewerContent } from "./FileViewer.js";
import { IconArrowUp, IconLoader2 } from "@renderer/lib/icons.js";

export function MobileViewerOverlay() {
  const target = useSessionStore((s) => s.mobileViewer);
  const close = useSessionStore((s) => s.closeMobileViewer);
  if (!target) return null;

  const title =
    target.kind === "plan"
      ? "计划"
      : target.kind === "file"
        ? target.name
        : basename(target.path);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-2">
        <button
          type="button"
          onClick={close}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-content-muted hover:bg-surface-muted"
        >
          <IconArrowUp size={14} className="rotate-[-90deg]" />
          返回
        </button>
        <div
          className={
            target.kind === "plan"
              ? "min-w-0 flex-1 truncate text-center text-xs text-content"
              : "min-w-0 flex-1 truncate text-center font-mono text-xs text-content"
          }
        >
          {title}
        </div>
        <span className="w-12" />
      </div>

      {target.kind === "file" && <FileViewerContent name={target.name} path={target.path} />}
      {target.kind === "diff" && <DiffContent path={target.path} before={target.before} />}
      {target.kind === "plan" && (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <Markdown>{target.plan}</Markdown>
        </div>
      )}
    </div>
  );
}

/** Turn-diff body: fetches the file's current on-disk content and diffs it
 *  against the frozen pre-turn `before` snapshot carried by the card. Uses
 *  the shared lineDiff + DiffView (line-numbered, red/green) — no git
 *  dependency, so it also works after the changes were committed.
 *
 *  `before` may be undefined on cards persisted by builds predating the
 *  snapshot field — diffing is impossible then, so degrade to the plain
 *  read-only file view with a hint instead of crashing lineDiff. */
function DiffContent({ path, before }: { path: string; before: string | undefined }) {
  const [after, setAfter] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAfter(null);
    setFailed(false);
    void api.file
      .readFile({ filePath: path })
      .then((res) => {
        if (!cancelled) setAfter(res.content ?? "");
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (before === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-edge bg-surface-muted/60 px-3 py-1.5 text-center text-[11px] text-content-subtle">
          该轮次缺少修改前快照（旧版本会话），以下为文件当前内容
        </div>
        <FileViewerContent name={basename(path)} path={path} />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">
        无法读取文件（可能已被删除）
      </div>
    );
  }
  if (after === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-content-subtle">
        <IconLoader2 size={16} className="animate-spin" />
      </div>
    );
  }
  const diff = lineDiff(before, after);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <DiffView diff={diff} scrollClassName="max-h-none h-full" />
    </div>
  );
}
