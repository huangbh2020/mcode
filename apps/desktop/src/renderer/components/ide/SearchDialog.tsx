import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { FileSearchEntry, FileGrepEntry } from "@contracts/ipc";
import {
  IconSearch,
  IconX,
  IconFile,
  IconFileSearch,
  IconTextScan2,
  IconLoader2,
  IconChevronDown,
  IconLetterCase,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Search debounce + result caps. Name/content share the debounce; caps differ
 *  (name search returns files, content returns line-level matches). Mirrors the
 *  FilesPanel constants these values migrated from. */
const SEARCH_DEBOUNCE_MS = 120;
const NAME_SEARCH_LIMIT = 80;
const GREP_LIMIT = 200;
const GREP_MAX_PER_FILE = 10;

/** Which field the search targets. Toggled by an icon button in the header. */
type SearchMode = "name" | "content";

/**
 * File search dialog - a modal overlay for project-wide file search.
 *
 * Replaces the FilesPanel's old inline search box with a fuller-featured modal
 * (VS Code global-search style). Two modes, toggled by a header icon button:
 *  - `name`    - match file names / paths (api.file.search), flat file list.
 *  - `content` - match text inside files (api.file.grep), grouped by file with
 *                matched lines + line numbers + a case-sensitivity toggle.
 *
 * Opened from the Files panel search button, the `files.search` command, or the
 * global Cmd/Ctrl+Shift+F hotkey (wired in App.tsx). Visibility lives in the
 * session store (`searchDialogOpen`), mirroring the command-palette pattern.
 *
 * Clicking a result opens it in the CENTER pane editor (via openFileInIde) and
 * closes the dialog - the user is done searching once a target is picked. Esc
 * (or the close button / backdrop) also closes. The query / mode /
 * case-sensitivity survive a close, so reopening resumes the last search
 * (VS Code global-search behavior); the query is selected on reopen so typing
 * overwrites it. Mount once at the App root.
 *
 * The search logic (debounce + reqIdRef stale-guard + keyboard nav + match
 * highlighting) migrated verbatim from the old inline search in FilesPanel.tsx;
 * the IPC channels (`file.search` / `file.grep`) are unchanged.
 */
export function SearchDialog() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.searchDialogOpen);
  const setOpen = useSessionStore((s) => s.setSearchDialogOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    const proj = projects.find((p) => p.id === activeProjectId);
    return proj?.path ?? null;
  }, [activeProjectId, projects]);

  // Search state. query / mode / caseSensitive survive a close so reopening
  // resumes the last search; only transient per-open state is reset below.
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [nameResults, setNameResults] = useState<FileSearchEntry[]>([]);
  const [grepResults, setGrepResults] = useState<FileGrepEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Request-id guard: a newer search drops stale in-flight responses so a slow
  // earlier query can't overwrite a newer one's results.
  const reqIdRef = useRef(0);

  const isSearching = query.trim().length > 0;
  // The "flat" result count activeIdx navigates over: one per file in name
  // mode, one per matched line in content mode.
  const flatCount = mode === "name" ? nameResults.length : grepResults.length;

  // Drop transient per-open state when the dialog closes (and invalidate any
  // in-flight request), but keep the query / mode / case sensitivity so the
  // next open resumes the last search. The search effect re-runs on open (its
  // deps include `open`), refreshing results for the preserved query.
  useEffect(() => {
    if (open) return;
    setActiveIdx(0);
    setLoading(false);
    reqIdRef.current++;
  }, [open]);

  // Debounced search driven by the query + mode + case-sensitivity. Each mode
  // hits its own IPC channel; switching mode clears the other mode's results so
  // stale hits never show. (caseSensitive only applies to content search - the
  // name-search backend is always case-insensitive.)
  useEffect(() => {
    if (!open || !isSearching || !projectPath) {
      setNameResults([]);
      setGrepResults([]);
      setLoading(false);
      setActiveIdx(0);
      return;
    }
    setLoading(true);
    const myId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      const promise =
        mode === "name"
          ? api.file
              .search({ projectPath, query: query.trim(), limit: NAME_SEARCH_LIMIT })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setNameResults(res.files ?? []);
                setGrepResults([]);
              })
          : api.file
              .grep({
                projectPath,
                query: query.trim(),
                limit: GREP_LIMIT,
                maxResultsPerFile: GREP_MAX_PER_FILE,
                caseSensitive,
              })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setGrepResults(res.matches ?? []);
                setNameResults([]);
              });
      void promise
        .then(() => {
          if (reqIdRef.current !== myId) return;
          setActiveIdx(0);
          setLoading(false);
        })
        .catch(() => {
          if (reqIdRef.current !== myId) return;
          setNameResults([]);
          setGrepResults([]);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, query, mode, caseSensitive, projectPath, isSearching]);

  // Keep the keyboard-active row scrolled into view while navigating.
  useEffect(() => {
    if (!isSearching) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, isSearching, flatCount]);

  // Open a result and close the dialog - picking a target ends the search.
  const openResult = (path: string) => {
    openFileInIde(path);
    setOpen(false);
  };

  // Open the flat-active item: a file in name mode, or the file of the active
  // matched line in content mode.
  const openActive = () => {
    if (mode === "name") {
      const f = nameResults[activeIdx];
      if (f) openResult(f.path);
    } else {
      const m = grepResults[activeIdx];
      if (m) openResult(m.path);
    }
  };

  // Keyboard nav lives on the input: while searching, focus stays in the search
  // box, so arrow/enter/esc are simplest handled here. Esc clears the query if
  // there is one, otherwise closes the dialog.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (flatCount === 0) return;
      e.preventDefault();
      setActiveIdx((i) => Math.min(flatCount - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      if (flatCount === 0) return;
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      if (flatCount === 0) return;
      e.preventDefault();
      openActive();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
        inputRef.current?.focus();
      } else {
        setOpen(false);
      }
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "name" ? "content" : "name"));
    // Different modes target different result sets; clear both so no stale hits
    // linger while the new mode's (debounced) search runs.
    setQuery("");
    setNameResults([]);
    setGrepResults([]);
    setActiveIdx(0);
    inputRef.current?.focus();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => setOpen(o)}
      // Focus (and select) the input when the dialog opens so typing works
      // immediately; selecting lets a fresh keystroke replace the remembered
      // query while reopening still shows what was last searched.
      onOpenChangeComplete={(o) => {
        if (!o) return;
        inputRef.current?.focus();
        inputRef.current?.select();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[85vh] w-[min(92vw,640px)] flex-col overflow-hidden p-0">
          {/* Header: search input + mode toggle (+ case-sensitivity in content mode). */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-2.5">
            <button
              type="button"
              onClick={toggleMode}
              title={mode === "name" ? t("ide.search.modeNameHint") : t("ide.search.modeContentHint")}
              aria-label={mode === "name" ? t("ide.search.switchToContentAria") : t("ide.search.switchToNameAria")}
              className={cn(
                "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
                "text-content-subtle hover:bg-surface-hover hover:text-content",
              )}
            >
              {mode === "name" ? <IconFileSearch size={16} /> : <IconTextScan2 size={16} />}
            </button>
            <IconSearch size={14} className="shrink-0 text-content-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={mode === "name" ? t("ide.search.namePlaceholder") : t("ide.search.contentPlaceholder")}
              spellCheck={false}
              className="h-6 min-w-0 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-content-subtle"
            />
            {/* Case-sensitivity toggle - content mode only (name search backend
                is always case-insensitive). Wired to FileGrepInput.caseSensitive. */}
            {mode === "content" && (
              <button
                type="button"
                onClick={() => {
                  setCaseSensitive((v) => !v);
                  inputRef.current?.focus();
                }}
                title={caseSensitive ? t("ide.search.caseOn") : t("ide.search.caseOff")}
                aria-label={t("ide.search.caseToggleAria")}
                aria-pressed={caseSensitive}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
                  caseSensitive
                    ? "bg-accent/15 text-accent"
                    : "text-content-subtle hover:bg-surface-hover hover:text-content",
                )}
              >
                <IconLetterCase size={16} />
              </button>
            )}
            {loading ? (
              <IconLoader2 size={14} className="shrink-0 animate-spin text-content-subtle" />
            ) : query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="shrink-0 rounded text-content-subtle transition-colors hover:text-content"
                title={t("ide.search.clear")}
              >
                <IconX size={15} />
              </button>
            ) : null}
          </div>

          {/* Body: results while a query is active, idle hint otherwise. */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {projectPath ? (
              isSearching ? (
                mode === "name" ? (
                  <NameSearchResults
                    loading={loading}
                    results={nameResults}
                    activeIdx={activeIdx}
                    onHover={setActiveIdx}
                    onOpen={openResult}
                  />
                ) : (
                  <ContentSearchResults
                    loading={loading}
                    results={grepResults}
                    activeIdx={activeIdx}
                    onHover={setActiveIdx}
                    onOpen={openResult}
                  />
                )
              ) : (
                <div className="flex h-full min-h-[160px] items-center justify-center px-4 text-center text-[12px] text-content-subtle">
                  {mode === "name"
                    ? t("ide.search.nameIdleHint")
                    : t("ide.search.contentIdleHint")}
                </div>
              )
            ) : (
              <div className="flex h-full min-h-[160px] items-center justify-center px-4 text-center text-[12px] text-content-subtle">
                {t("ide.search.noProjectHint")}
              </div>
            )}
          </div>

          {/* Footer: keybind hints + result count. Styles mirror CommandPalette. */}
          <div className="flex shrink-0 items-center justify-between border-t border-edge px-3 py-1.5 text-[10px] text-content-subtle">
            <span className="flex items-center gap-2">
              <span>
                <kbd className="rounded border border-edge px-1">↑</kbd>
                <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>{" "}
                {t("ide.search.navigate")}
              </span>
              <span>
                <kbd className="rounded border border-edge px-1">↵</kbd> {t("common.open")}
              </span>
              <span>
                <kbd className="rounded border border-edge px-1">esc</kbd> {t("common.close")}
              </span>
            </span>
            <span>
              {isSearching
                ? t("ide.search.resultCount", { n: flatCount })
                : mode === "name"
                  ? t("ide.search.modeName")
                  : t("ide.search.modeContent")}
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────────────────────── name-search results ───────────────────────── */

/** Flat list of file-name matches. Each row shows the file name (primary) and
 *  its project-relative path (secondary) so same-named files stay distinguishable. */
function NameSearchResults({
  loading,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  results: FileSearchEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
        <IconLoader2 size={14} className="animate-spin" />
        {t("ide.search.searching")}
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-content-subtle">{t("ide.search.noFileMatch")}</div>
    );
  }
  return (
    <div className="py-1 text-[13px]">
      {results.map((f, idx) => {
        const isActive = idx === activeIdx;
        return (
          <button
            key={f.path}
            type="button"
            data-idx={idx}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onOpen(f.path)}
            className={cn(
              "flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors",
              isActive ? "bg-accent/15 text-content" : "text-content-muted hover:bg-surface-hover/50",
            )}
            title={f.path}
          >
            <span className="shrink-0 text-content-subtle">
              <IconFile size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{f.name}</span>
              <span className="block truncate text-[11px] text-content-subtle">
                {f.relativePath}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── content search ───────────────────────── */

interface GrepGroup {
  path: string;
  relativePath: string;
  fileName: string;
  lines: FileGrepEntry[];
}

/** Group line-level grep matches by file (paths repeat across matches). */
function groupByFile(matches: FileGrepEntry[]): GrepGroup[] {
  const groups: GrepGroup[] = [];
  const byPath = new Map<string, GrepGroup>();
  for (const m of matches) {
    let g = byPath.get(m.path);
    if (!g) {
      const fileName = m.relativePath.split("/").pop() ?? m.relativePath;
      g = { path: m.path, relativePath: m.relativePath, fileName, lines: [] };
      byPath.set(m.path, g);
      groups.push(g);
    }
    g.lines.push(m);
  }
  return groups;
}

/** Content-search results: matches grouped by file, each file a collapsible-
 *  looking header (clickable to open) with its matched lines underneath. Line
 *  rows carry the flat `data-idx` (position in the ungrouped match array) so
 *  keyboard navigation and scrollIntoView work against the same flat index. */
function ContentSearchResults({
  loading,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  results: FileGrepEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const groups = useMemo(() => groupByFile(results), [results]);

  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
        <IconLoader2 size={14} className="animate-spin" />
        {t("ide.search.searching")}
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-content-subtle">{t("ide.search.noContentMatch")}</div>
    );
  }

  // Walk groups to compute each line's flat index for data-idx / active state.
  let flatIdx = -1;

  return (
    <div className="py-1 text-[13px]">
      {groups.map((g) => (
        <div key={g.path} className="mb-0.5">
          {/* File header: clickable to open the file in the editor. */}
          <button
            type="button"
            onClick={() => onOpen(g.path)}
            className={cn(
              "flex w-full items-center gap-1 px-3 py-1 text-left transition-colors",
              "text-content hover:bg-surface-hover/50",
            )}
            title={g.path}
          >
            <span className="shrink-0 text-content-subtle">
              <IconChevronDown size={13} />
            </span>
            <span className="shrink-0 text-content-subtle">
              <IconFile size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {g.fileName}
            </span>
            <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-content-subtle">
              {g.lines.length}
            </span>
          </button>
          {/* Matched lines under this file. */}
          {g.lines.map((m) => {
            flatIdx += 1;
            const isActive = flatIdx === activeIdx;
            return (
              <button
                key={`${m.path}:${m.lineNumber}`}
                type="button"
                data-idx={flatIdx}
                onMouseEnter={() => onHover(flatIdx)}
                onClick={() => onOpen(m.path)}
                className={cn(
                  "flex w-full items-start gap-2 py-0.5 pr-3 pl-8 text-left transition-colors",
                  isActive
                    ? "bg-accent/15 text-content"
                    : "text-content-muted hover:bg-surface-hover/50",
                )}
                title={m.path}
              >
                <span className="shrink-0 select-none text-[10px] leading-6 text-content-subtle">
                  {m.lineNumber}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-6">
                  <HighlightedLine line={m.lineText} matches={m.matches} />
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Renders a matched line with each query occurrence highlighted. Splits the
 *  line around the match ranges and wraps the matched spans in an accent style. */
function HighlightedLine({
  line,
  matches,
}: {
  line: string;
  matches: Array<{ start: number; end: number }>;
}) {
  if (matches.length === 0) {
    return <>{line}</>;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.start > cursor) {
      parts.push(<span key={`t${i}`}>{line.slice(cursor, m.start)}</span>);
    }
    parts.push(
      <mark key={`m${i}`} className="rounded-sm bg-accent/30 px-0.5 text-content">
        {line.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  if (cursor < line.length) {
    parts.push(<span key="tail">{line.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}
