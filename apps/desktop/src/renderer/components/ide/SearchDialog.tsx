import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { FileSearchEntry, FileGrepEntry } from "@contracts/ipc";
import { SEARCH_FILE_TYPES_SETTING_KEY } from "@contracts/ipc";
import {
  IconSearch,
  IconX,
  IconFile,
  IconFileSearch,
  IconTextScan2,
  IconLoader2,
  IconChevronDown,
  IconLetterCase,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useRgStatus } from "@renderer/lib/useRgStatus.js";

/** Search debounce + result caps. Name/content share the debounce; caps differ
 *  (name search returns files, content returns line-level matches). Mirrors the
 *  FilesPanel constants these values migrated from. */
const SEARCH_DEBOUNCE_MS = 120;
const NAME_SEARCH_LIMIT = 200;
const GREP_LIMIT = 400;
const GREP_MAX_PER_FILE = 10;

/** Cap on how many file-type filters are remembered (datalist size). */
const FILE_TYPE_HISTORY_MAX = 10;

/** Parse the free-form file-type input into a bare-extension allow-list.
 *  Accepts `*.java` / `.java` / bare `java`, and comma- or space-separated
 *  lists of those; anything not shaped like a plain extension is dropped
 *  (the backend filter only understands extensions). */
function parseFileTypeInput(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const exts = new Set<string>();
  for (const part of raw.split(/[,，;；\s]+/)) {
    let p = part.trim();
    if (p.startsWith("*.")) p = p.slice(2);
    else if (p.startsWith(".")) p = p.slice(1);
    p = p.toLowerCase();
    if (p && /^[a-z0-9]+$/.test(p)) exts.add(p);
  }
  return [...exts];
}

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
 * (or the close button / backdrop) also closes. The query / case-sensitivity /
 * file-type filter survive a close so reopening resumes the last search, while
 * the MODE always resets to content search (the dialog's default). The query
 * is selected on reopen so typing overwrites it. Mount once at the App root.
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

  // Search state. The query / case sensitivity / file-type filter survive a
  // close so reopening resumes the last search; the MODE always resets to
  // content search on close (the dialog's default). Only transient per-open
  // state is reset below.
  const [mode, setMode] = useState<SearchMode>("content");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fileType, setFileType] = useState<string>("");
  // Previously typed file-type filters (persisted in settings; the datalist
  // auto-completes from this).
  const [fileTypeHistory, setFileTypeHistory] = useState<string[]>([]);
  const [nameResults, setNameResults] = useState<FileSearchEntry[]>([]);
  const [grepResults, setGrepResults] = useState<FileGrepEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Whether the backend's result was cut short: `truncated` = more matches
  // existed than the result cap (we got a slice), `incompleteScan` = the tree
  // walk budget ran out (parts of the project were never looked at). Both
  // render an amber hint so a partial result is never mistaken for exhaustive.
  const [truncated, setTruncated] = useState(false);
  const [incompleteScan, setIncompleteScan] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Request-id guard: a newer search drops stale in-flight responses so a slow
  // earlier query can't overwrite a newer one's results.
  const reqIdRef = useRef(0);

  // ripgrep availability for the install banner (checked on open). Searches
  // work without it (slow JS fallback); the banner offers a one-click install.
  const rg = useRgStatus(open);

  // Extension allow-list parsed from the free-form file-type input ("" = no
  // filter → undefined, keeping the IPC payload minimal).
  const includeExts = useMemo(() => parseFileTypeInput(fileType), [fileType]);

  const isSearching = query.trim().length > 0;
  // The "flat" result count activeIdx navigates over: one per file in name
  // mode, one per matched line in content mode.
  const flatCount = mode === "name" ? nameResults.length : grepResults.length;

  // Promote the current filter into the remembered history (dedup + cap).
  // Called on Enter in the file-type field and on dialog close.
  const rememberFileType = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setFileTypeHistory((prev) =>
      prev[0] === v ? prev : [v, ...prev.filter((h) => h !== v)].slice(0, FILE_TYPE_HISTORY_MAX),
    );
  };

  // Drop transient per-open state when the dialog closes (and invalidate any
  // in-flight request). The query / case sensitivity / file-type filter
  // survive a close so reopening resumes the last search; the MODE always
  // resets to content search — the dialog's default per user request. The
  // current file-type filter is also folded into the remembered history. The
  // search effect re-runs on open (its deps include `open`), refreshing
  // results for the preserved query.
  useEffect(() => {
    if (open) return;
    setActiveIdx(0);
    setLoading(false);
    setTruncated(false);
    setIncompleteScan(false);
    setMode("content");
    rememberFileType(fileType);
    reqIdRef.current++;
  }, [open, fileType]);

  // Remembered file-type filters: hydrate from settings on open so the
  // datalist shows previously typed values.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.setting
      .get({ key: SEARCH_FILE_TYPES_SETTING_KEY })
      .then((res) => {
        if (cancelled || !res.value) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.value);
        } catch {
          return; // not a JSON array (unset / legacy) — keep empty history
        }
        if (Array.isArray(parsed)) {
          setFileTypeHistory(
            parsed.filter((v): v is string => typeof v === "string").slice(0, FILE_TYPE_HISTORY_MAX),
          );
        }
      })
      .catch(() => {
        // settings read failure — history just stays empty
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Persist the history whenever it changes (writing the same list back on
  // hydrate is harmless).
  useEffect(() => {
    if (fileTypeHistory.length === 0) return;
    void api.setting
      .set({ key: SEARCH_FILE_TYPES_SETTING_KEY, value: JSON.stringify(fileTypeHistory) })
      .catch(() => {});
  }, [fileTypeHistory]);

  // Debounced search driven by the query + mode + case-sensitivity. Each mode
  // hits its own IPC channel; switching mode clears the other mode's results so
  // stale hits never show. (caseSensitive only applies to content search - the
  // name-search backend is always case-insensitive.)
  useEffect(() => {
    if (!open || !isSearching || !projectPath) {
      setNameResults([]);
      setGrepResults([]);
      setLoading(false);
      setTruncated(false);
      setIncompleteScan(false);
      setActiveIdx(0);
      return;
    }
    setLoading(true);
    const myId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      const promise =
        mode === "name"
          ? api.file
              .search({
                projectPath,
                query: query.trim(),
                limit: NAME_SEARCH_LIMIT,
                includeExts: includeExts.length ? includeExts : undefined,
              })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setNameResults(res.files ?? []);
                setGrepResults([]);
                setTruncated(res.truncated);
                setIncompleteScan(res.incompleteScan);
              })
          : api.file
              .grep({
                projectPath,
                query: query.trim(),
                limit: GREP_LIMIT,
                maxResultsPerFile: GREP_MAX_PER_FILE,
                caseSensitive,
                includeExts: includeExts.length ? includeExts : undefined,
              })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setGrepResults(res.matches ?? []);
                setNameResults([]);
                setTruncated(res.truncated);
                setIncompleteScan(res.incompleteScan);
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
          setTruncated(false);
          setIncompleteScan(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, query, mode, caseSensitive, projectPath, isSearching, fileType]);

  // Keep the keyboard-active row scrolled into view while navigating.
  useEffect(() => {
    if (!isSearching) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, isSearching, flatCount]);

  // Open a result and close the dialog - picking a target ends the search. For
  // content matches the hit line is passed so the editor reveals it.
  const openResult = (path: string, line?: number) => {
    openFileInIde(path, line != null ? { line } : undefined);
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
      if (m) openResult(m.path, m.lineNumber);
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
            {/* File-type filter: free-form input (auto-completes from previously typed
                values via the datalist). Accepts "*.java"/".java"/"java" and
                comma- or space-separated lists. Wired to includeExts on both
                IPC channels. */}
            <input
              list="search-filetype-list"
              value={fileType}
              onChange={(e) => setFileType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fileType.trim()) rememberFileType(fileType);
              }}
              placeholder={t("ide.search.fileTypePlaceholder")}
              title={t("ide.search.fileTypeHint")}
              aria-label={t("ide.search.fileTypeHint")}
              spellCheck={false}
              className="h-6 w-[84px] shrink-0 rounded border border-edge bg-transparent px-1 text-[11px] text-content-muted outline-none placeholder:text-content-subtle hover:text-content focus:text-content"
            />
            <datalist id="search-filetype-list">
              {fileTypeHistory.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
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

          {/* ripgrep missing banner: searches still work through the JS
              fallback, but a one-click install restores the fast C path. */}
          {!rg.ready && (
            <div className="flex flex-col gap-1 border-b border-edge bg-warning/10 px-3 py-1.5">
              <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
                <IconAlertTriangle size={13} className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate">{t("ide.search.rgMissingHint")}</span>
                {rg.installing ? (
                  <span className="flex shrink-0 items-center gap-1 text-content-subtle">
                    <IconLoader2 size={12} className="animate-spin" />
                    {t("ide.search.rgInstalling")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void rg.install()}
                    className="shrink-0 rounded border border-accent/40 px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
                  >
                    {t("ide.search.rgInstall")}
                  </button>
                )}
              </div>
              {rg.error && (
                <div className="text-[11px] text-content-subtle">
                  {t("ide.search.rgInstallFailed", { error: rg.error })}
                </div>
              )}
            </div>
          )}

          {/* Body: results while a query is active, idle hint otherwise. */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {projectPath ? (
              isSearching ? (
                mode === "name" ? (
                  <NameSearchResults
                    loading={loading}
                    truncated={truncated}
                    incompleteScan={incompleteScan}
                    results={nameResults}
                    activeIdx={activeIdx}
                    onHover={setActiveIdx}
                    onOpen={openResult}
                  />
                ) : (
                  <ContentSearchResults
                    loading={loading}
                    truncated={truncated}
                    incompleteScan={incompleteScan}
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

/** Amber hint shown above results when the backend couldn't return the full
 *  set: the match cap was hit (more matches exist than shown) and/or the tree
 *  walk budget ran out (parts of the project were never scanned). Mirrors the
 *  planApprovalBroken card tone — informative, not an error. */
function SearchHintBanner({
  truncated,
  incompleteScan,
}: {
  truncated: boolean;
  incompleteScan: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-1 flex flex-col gap-1 border border-warning/50 bg-warning/10 px-2.5 py-1.5">
      {truncated && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
          <IconAlertTriangle size={13} className="shrink-0" />
          <span>{t("ide.search.truncatedHint")}</span>
        </div>
      )}
      {incompleteScan && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
          <IconAlertTriangle size={13} className="shrink-0" />
          <span>{t("ide.search.scanIncompleteHint")}</span>
        </div>
      )}
    </div>
  );
}

/** Flat list of file-name matches. Each row shows the file name (primary) and
 *  its project-relative path (secondary) so same-named files stay distinguishable. */
function NameSearchResults({
  loading,
  truncated,
  incompleteScan,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  truncated: boolean;
  incompleteScan: boolean;
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
      {!loading && (truncated || incompleteScan) && (
        <SearchHintBanner truncated={truncated} incompleteScan={incompleteScan} />
      )}
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
  truncated,
  incompleteScan,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  truncated: boolean;
  incompleteScan: boolean;
  results: FileGrepEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onOpen: (path: string, line?: number) => void;
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
      {!loading && (truncated || incompleteScan) && (
        <SearchHintBanner truncated={truncated} incompleteScan={incompleteScan} />
      )}
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
                onClick={() => onOpen(m.path, m.lineNumber)}
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
