/**
 * Inline, clickable file-path link for chat output.
 *
 * Renders as a dotted-underlined accent-colored `<span>` inside prose. On
 * click (or Enter/Space for keyboard users) it asynchronously resolves the
 * token via {@link resolveFilePathToken}:
 *  - 1 candidate  -> opens it directly in the IDE editor (`openFileInIde`).
 *  - >1 candidate -> opens a base-ui `Menu` anchored to the span listing the
 *                    matches (file-type icon + relative path); selecting one
 *                    opens it.
 *  - 0 candidates -> opens a small menu with a disabled "未找到匹配文件" row.
 *
 * Resolution is click-triggered and IPC-bound, never at render time, so this
 * component is cheap to embed in streaming markdown text nodes.
 */
import { useMemo, useRef, useState, type MouseEvent, type KeyboardEvent } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { basename } from "@renderer/lib/path.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import {
  resolveFilePathToken,
  type ResolvedCandidate,
} from "@renderer/lib/fileLink.js";
import { IconLoader2, IconAlertTriangle } from "@renderer/lib/icons.js";

/** Shared menu styling - mirrors OpenTabsBar/FileTree for consistency. */
const MENU_POPUP_CLASS = cn(
  "z-50 min-w-[220px] max-w-[400px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
  "transition-[transform,opacity] duration-100",
);
const MENU_ITEM_CLASS = cn(
  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-content-muted outline-none select-none",
  "data-[highlighted]:bg-surface-muted",
);

export function FileLink({
  token,
  projectPath,
}: {
  token: string;
  /** Project root to resolve relative tokens against. When null/undefined,
   *  only absolute-path tokens can be opened (safe degradation). */
  projectPath?: string | null;
}) {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ResolvedCandidate[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  /** Virtual anchor built from the span's current rect, so the candidate
   *  menu opens right below the clicked token. Recomputed each open via the
   *  controlled `open` transition (we only need it while open). */
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => {
        const el = spanRef.current;
        if (!el) {
          return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
        }
        return el.getBoundingClientRect();
      },
    }),
    [],
  );

  /** Open a resolved candidate: the desktop shell opens the IDE editor; the
   *  mobile shell has no editor column, so it opens the read-only fullscreen
   *  viewer instead. */
  const openCandidatePath = (c: ResolvedCandidate) => {
    const store = useSessionStore.getState();
    if (isElectron) {
      store.openFileInIde(c.path);
    } else {
      store.openMobileViewer({ kind: "file", name: basename(c.path), path: c.path });
    }
  };

  const resolve = async () => {
    if (loading) return;
    setLoading(true);
    setCandidates(null);
    try {
      const result = await resolveFilePathToken(token, projectPath);
      setCandidates(result);
      if (result.length === 1) {
        // Unique match - open immediately, no menu.
        openCandidatePath(result[0]);
        setMenuOpen(false);
      } else {
        // 0 or >1 - show the picker (empty state renders a disabled row).
        setMenuOpen(true);
      }
    } catch {
      setCandidates([]);
      setMenuOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = (e: MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    void resolve();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      void resolve();
    }
  };

  const openCandidate = (c: ResolvedCandidate) => {
    openCandidatePath(c);
    setMenuOpen(false);
  };

  return (
    <>
      <span
        ref={spanRef}
        role="button"
        tabIndex={0}
        title="点击打开文件"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "cursor-pointer rounded-[2px] underline decoration-dotted decoration-accent/60 underline-offset-2",
          "text-accent hover:bg-accent/10",
          loading && "opacity-60",
        )}
      >
        {token}
        {loading && <IconLoader2 size={10} className="ml-0.5 inline animate-spin align-baseline opacity-70" />}
      </span>

      <Menu.Root open={menuOpen} onOpenChange={(open) => setMenuOpen(open)}>
        <Menu.Portal>
          <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4}>
            <Menu.Popup className={MENU_POPUP_CLASS}>
              {candidates === null ? null : candidates.length === 0 ? (
                <div className={cn(MENU_ITEM_CLASS, "cursor-default opacity-70")}>
                  <IconAlertTriangle size={14} className="shrink-0 text-content-subtle" />
                  <span>未找到匹配文件</span>
                </div>
              ) : (
                <>
                  <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                    {candidates.length} 个匹配 · 选择打开
                  </div>
                  {candidates.map((c) => (
                    <Menu.Item
                      key={c.path}
                      className={MENU_ITEM_CLASS}
                      onClick={() => openCandidate(c)}
                    >
                      <FileTypeIcon path={c.path} size={14} className="shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-content">{basename(c.path)}</span>
                        <span className="block truncate text-[10px] text-content-subtle">{c.relativePath}</span>
                      </span>
                    </Menu.Item>
                  ))}
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}
