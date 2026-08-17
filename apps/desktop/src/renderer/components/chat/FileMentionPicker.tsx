/**
 * Project-file picker for composer @-mentions and the "add context" button.
 *
 * Anchored above the composer (fixed position from an anchor rect). Loads
 * candidates via `api.file.search` with a debounced query. Keyboard:
 * ↑↓ move, Enter/Tab confirm, Esc close.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { IconFile, IconLoader2, IconPaperclip, IconSearch, IconUpload } from "@renderer/lib/icons.js";
import type { FileSearchEntry } from "@contracts/ipc";

export type FileMentionPickerMode = "mention" | "attach";

export interface FileMentionPickerProps {
  open: boolean;
  /** Project root absolute path; null shows an empty-state tip. */
  projectPath: string | null;
  /** Filter query (without the leading @). Used in "mention" mode; ignored in
   *  "attach" mode, which owns its own search input. */
  query?: string;
  /** Anchor rect (composer box or textarea) for positioning. */
  anchorRect: DOMRect | null;
  mode: FileMentionPickerMode;
  /** Paths already attached — shown muted / skipped on pick when attach. */
  excludePaths?: ReadonlyArray<string>;
  onPick: (files: FileSearchEntry[]) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 120;
const LIMIT = 60;

export function FileMentionPicker({
  open,
  projectPath,
  query,
  anchorRect,
  mode,
  excludePaths = [],
  onPick,
  onClose,
}: FileMentionPickerProps) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileSearchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // attach mode owns a local search input (no textarea to drive it).
  const [localQuery, setLocalQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);
  const exclude = new Set(excludePaths);

  const effectiveQuery = mode === "attach" ? localQuery : query ?? "";

  // Reset transient state when reopened.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setLocalQuery("");
      setActiveIdx(0);
      if (mode === "attach") {
        // Focus the inline search input shortly after mount.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
  }, [open, mode]);

  // Keep the selection on the first row while the user types, mirroring the
  // SlashCommandPicker. The debounced search also resets on result, but this
  // covers the gap between keystroke and result arrival so the highlight
  // doesn't linger on a now-stale row index.
  useEffect(() => {
    if (open) setActiveIdx(0);
  }, [open, effectiveQuery]);

  // Debounced search driven by the effective query.
  useEffect(() => {
    if (!open) return;
    if (!projectPath) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      void api.file
        .search({
          projectPath,
          query: effectiveQuery.trim() || undefined,
          limit: LIMIT,
        })
        .then((res) => {
          if (reqIdRef.current !== myId) return;
          setFiles(res.files ?? []);
          setActiveIdx(0);
          setLoading(false);
        })
        .catch(() => {
          if (reqIdRef.current !== myId) return;
          setFiles([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, projectPath, effectiveQuery]);

  // Keep active row in view.
  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, files]);

  const confirmMention = useCallback(
    (file: FileSearchEntry) => {
      onPick([file]);
    },
    [onPick],
  );

  const toggleAttach = useCallback((file: FileSearchEntry) => {
    if (exclude.has(file.path)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }, [exclude]);

  const confirmAttach = useCallback(() => {
    const picked = files.filter((f) => selected.has(f.path) && !exclude.has(f.path));
    if (picked.length === 0 && files[activeIdx] && !exclude.has(files[activeIdx].path)) {
      onPick([files[activeIdx]]);
      return;
    }
    if (picked.length > 0) onPick(picked);
  }, [files, selected, exclude, activeIdx, onPick]);

  /** Open the native OS file picker so the user can attach files from OUTSIDE
   *  the project root (unlike `file.search`, which main scopes to known
   *  projects). Selected paths are mapped to `FileSearchEntry`-shaped objects
   *  and forwarded via `onPick` — the same callback the in-project attach flow
   *  uses — so downstream tag creation / dedup / chip rendering is unchanged.
   *  `relativePath` is set to the full path (there's no project root to relativize
   *  against); the chip only shows `name` anyway. */
  const handlePickExternal = useCallback(async () => {
    const { paths } = await api.pickFiles({});
    if (paths.length === 0) return; // user canceled
    const mapped: FileSearchEntry[] = paths.map((p) => {
      const segs = p.split(/[/\\]/);
      return { name: segs[segs.length - 1] || p, path: p, relativePath: p };
    });
    onPick(mapped);
  }, [onPick]);

  // Keyboard handling is owned by the parent textarea (so focus stays there),
  // but we expose an imperative-style handler via a window event is overkill —
  // parent calls nothing; instead parent wires keydown and we listen via
  // a custom callback ref pattern. For simplicity the parent passes key events
  // through `onKeyDownFromParent` by calling the exported helper… Actually we
  // attach a capturing keydown on window while open so arrows work even if
  // focus is on the attach button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(files.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (mode === "mention") {
          const f = files[activeIdx];
          if (f) confirmMention(f);
        } else {
          confirmAttach();
        }
      }
    };
    // Capture so we beat textarea Enter-to-send.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, files, activeIdx, mode, confirmMention, confirmAttach, onClose]);

  // Click outside the picker to close. Mirrors the ModelDropdown / TagPopover
  // pattern (document mousedown + ref.contains). Escape is already handled by
  // the capturing keydown listener above, so this only covers pointer
  // dismissal. Runs while open; cleaned up on close/unmount.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const top = Math.max(8, anchorRect.top - 8);
  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 280), 480);

  return (
    <div
      ref={rootRef}
      className={cn(
        "fixed z-[70] flex max-h-64 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl",
      )}
      style={{
        left,
        width,
        // Grow upward from the anchor top.
        top,
        transform: "translateY(-100%)",
      }}
      // In mention mode, prevent mousedown from stealing focus from the
      // textarea (keyboard stays there). In attach mode we WANT focus in our
      // own search input, so let default through.
      onMouseDown={mode === "mention" ? (e) => e.preventDefault() : undefined}
    >
      {mode === "attach" ? (
        <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
          <IconSearch size={12} className="shrink-0 text-content-muted" />
          <input
            ref={inputRef}
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder={t("chat.mention.searchPlaceholder")}
            className="h-6 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle"
          />
          {selected.size > 0 && (
            <button
              type="button"
              className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-surface hover:brightness-110"
              onClick={confirmAttach}
            >
              {t("chat.mention.addN", { n: selected.size })}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-b border-edge px-2.5 py-1.5 text-[11px] text-content-muted">
          <IconPaperclip size={12} className="shrink-0 opacity-70" />
          <span className="truncate">
            {t("chat.mention.header")}{effectiveQuery ? ` · ${effectiveQuery}` : ""}
          </span>
        </div>
      )}

      {mode === "attach" && (
        <button
          type="button"
          onClick={handlePickExternal}
          className={cn(
            "mx-1.5 mt-1.5 flex items-center gap-1.5 rounded-md border border-dashed border-edge px-2 py-1.5 text-left text-[12px] text-content-muted",
            "transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent",
          )}
          title={t("chat.mention.externalTitle")}
        >
          <IconUpload size={14} className="shrink-0" />
          <span className="flex-1">{t("chat.mention.externalPick")}</span>
          <span className="text-[10px] text-content-subtle">{t("chat.mention.externalHint")}</span>
        </button>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {!projectPath ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            {t("chat.mention.openProjectFirst")}
          </div>
        ) : loading && files.length === 0 ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("chat.mention.searching")}
          </div>
        ) : files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            {t("chat.mention.noMatch")}
          </div>
        ) : (
          files.map((f, idx) => {
            const already = exclude.has(f.path);
            const isActive = idx === activeIdx;
            const isSel = selected.has(f.path);
            return (
              <button
                key={f.path}
                type="button"
                data-idx={idx}
                disabled={already && mode === "mention"}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  if (mode === "mention") {
                    if (!already) confirmMention(f);
                  } else {
                    toggleAttach(f);
                  }
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                  isActive
                    ? "bg-accent/15 text-content ring-1 ring-inset ring-accent/40"
                    : "text-content hover:bg-surface-hover",
                  already && "opacity-50",
                )}
              >
                {mode === "attach" && (
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px]",
                      isSel || already
                        ? "border-accent bg-accent text-surface"
                        : "border-edge text-transparent",
                    )}
                  >
                    ✓
                  </span>
                )}
                <IconFile size={14} className="shrink-0 text-content-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{f.name}</span>
                  <span className="block truncate text-[10px] text-content-subtle">
                    {f.relativePath}
                  </span>
                </span>
                {already && (
                  <span className="shrink-0 text-[10px] text-content-subtle">{t("chat.mention.added")}</span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-edge px-2.5 py-1 text-[10px] text-content-subtle">
        <span>
          <kbd className="rounded border border-edge px-1">↑</kbd>
          <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>
          {" "}{t("chat.kbd.navigate")}{" "}
          <kbd className="ml-1 rounded border border-edge px-1">↵</kbd>
          {" "}
          {mode === "attach" ? t("chat.mention.confirm") : t("chat.mention.select")}
        </span>
        <span>{t("chat.mention.count", { n: files.length })}</span>
      </div>
    </div>
  );
}
