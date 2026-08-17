/**
 * Command palette (Ctrl/Cmd+K) — a unified, type-scoped search modal.
 *
 * A row of tabs at the top scopes the search so the user can target one kind
 * of result instead of always mixing all four:
 *
 *   全部     — every kind at once (the default; preserves the original feel).
 *   命令     — local label/keyword match (`commandMatches`, no IPC).
 *   线程     — `api.session.search` (cross-project title LIKE, non-archived).
 *   文件     — `api.file.search` (file-name/path match in the active project).
 *   文件内容 — `api.file.grep` (line-level content match in the active project).
 *
 * Typing switches the list in real time; selecting any item runs its `perform`
 * and closes the palette (one-shot, like every command palette). Tabs are also
 * drivable from the keyboard: ← / → while focused in the input cycle the active
 * tab, so the user never has to reach for the mouse.
 *
 * Architecture follows the Base UI documented pattern for a Combobox inside a
 * Dialog:
 *   - `Dialog.Root` (controlled by `commandPaletteOpen`) supplies the modal
 *     layer, backdrop, and top-centered positioning.
 *   - `Combobox.Root inline open` is embedded inside. `inline` renders the list
 *     inline (no separate popup); `open` follows the dialog so query/highlight
 *     reset on close.
 *   - The async searches use a debounce (120ms) + a monotonic request id
 *     (`reqIdRef`) to drop stale responses — the same proven pattern as
 *     SearchDialog. Each search has its own loading flag rendered next to its
 *     group label.
 *
 * The palette is mounted once at the App root (see App.tsx) so it overlays both
 * the workspace and settings views.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Combobox } from "@base-ui/react/combobox";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  collectCommands,
  commandMatches,
  type CommandDef,
} from "@renderer/lib/commands.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import type { Session } from "@contracts/session";
import type { FileSearchEntry, FileGrepEntry } from "@contracts/ipc";
import {
  IconLoader2,
  IconFile,
  IconFileSearch,
} from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

/** Translator signature used by the module-level copy helpers below. */
type Translator = (key: MessageId, params?: Record<string, string | number>) => string;

/** Debounce for the async searches. Matches SearchDialog's value. */
const SEARCH_DEBOUNCE_MS = 120;
/** Result caps keep the palette snappy and the list scrollable. */
const SESSION_SEARCH_LIMIT = 30;
const FILE_SEARCH_LIMIT = 50;
const GREP_LIMIT = 50;
const GREP_MAX_PER_FILE = 3;

/* ───────────────────────── search scope (tabs) ───────────────────────── */

/** Which kind(s) of results the palette should search + render. `all` mixes
 *  every kind (the original behaviour); the others scope to a single type so
 *  the user can target threads / files / content without noise. */
type SearchScope = "all" | "command" | "session" | "file" | "grep";

/** Tab descriptor: id + dictionary key + whether it needs an active project
 *  to be useful (file/content searches are project-scoped). Ordered for
 *  display. The key doubles as the palette group label (command groups and
 *  scope tabs read the same words). */
const SCOPE_TABS: { id: SearchScope; labelKey: MessageId; needsProject: boolean }[] = [
  { id: "all", labelKey: "layout.palette.all", needsProject: false },
  { id: "command", labelKey: "layout.palette.command", needsProject: false },
  { id: "session", labelKey: "layout.palette.session", needsProject: false },
  { id: "file", labelKey: "layout.palette.file", needsProject: true },
  { id: "grep", labelKey: "layout.palette.grep", needsProject: true },
];

/** Does `scope` include the given group? (`all` includes everything.) */
function scopeIncludes(scope: SearchScope, group: PaletteGroup): boolean {
  return scope === "all" || scope === group;
}

/* ───────────────────────── unified palette item ───────────────────────── */

/** Discriminated union of everything that can appear as a palette row. Each
 *  kind carries the data its renderer + `perform` need. `kind` doubles as the
 *  grouping key (the four groups render in a fixed order). */
type PaletteItem =
  | (CommandDef & { kind: "command" })
  | { kind: "session"; session: Session }
  | { kind: "file"; file: FileSearchEntry }
  | { kind: "grep"; match: FileGrepEntry };

/** Fixed group order for rendering. Commands always come first; the three
 *  search groups follow so the user reads top-down "action → thing → file". */
const GROUP_ORDER = ["command", "session", "file", "grep"] as const;
type PaletteGroup = (typeof GROUP_ORDER)[number];

const GROUP_LABELS: Record<PaletteGroup, MessageId> = {
  command: "layout.palette.command",
  session: "layout.palette.session",
  file: "layout.palette.file",
  grep: "layout.palette.grep",
};

/** Tri-state async result: undefined = idle, {loading:true} = pending,
 *  {loading:false,value} = settled. Stored directly in useState so the value
 *  reference is stable across renders. */
type AsyncResult<T> = undefined | { loading: true } | { loading: false; value: T };

/* ───────────────────────── component ───────────────────────── */

export function CommandPalette() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.commandPaletteOpen);
  const setOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  // Subscribe to overrides so <kbd> hints update live when the user rebinds.
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");

  // Async search state. `reqIdRef` guards against stale responses overwriting a
  // newer query's results (incremented per issued search; a response whose id
  // no longer matches is dropped).
  const reqIdRef = useRef(0);
  const [sessions, setSessions] = useState<AsyncResult<Session[]>>(undefined);
  const [files, setFiles] = useState<AsyncResult<FileSearchEntry[]>>(undefined);
  const [greps, setGreps] = useState<AsyncResult<FileGrepEntry[]>>(undefined);

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  // Build the command list on every open (freshly-created sessions appear
  // without a remount) and inject each command's effective shortcut hint.
  const commandItems = useMemo<(CommandDef & { kind: "command" })[]>(() => {
    if (!open) return [];
    return collectCommands(useSessionStore.getState()).map((cmd) => {
      const effective = resolveShortcut(cmd.id, overrides);
      return {
        ...cmd,
        shortcutHint: effective ? acceleratorToDisplayString(effective) : cmd.shortcutHint,
        kind: "command" as const,
      };
    });
  }, [open, overrides]);

  // Drive the async searches off the live query + active scope. Only the
  // searches the current scope includes are fired, so picking e.g. "线程" never
  // wastes a file/content scan. File/content searches additionally require an
  // active project; session search is cross-project.
  useEffect(() => {
    const wantSession = scopeIncludes(scope, "session");
    const wantFile = scopeIncludes(scope, "file") && !!projectPath;
    const wantGrep = scopeIncludes(scope, "grep") && !!projectPath;
    if (!open || !isSearching) {
      setSessions(undefined);
      setFiles(undefined);
      setGreps(undefined);
      return;
    }
    if (wantSession) setSessions({ loading: true });
    else setSessions(undefined);
    if (wantFile) setFiles({ loading: true });
    else setFiles(undefined);
    if (wantGrep) setGreps({ loading: true });
    else setGreps(undefined);
    const myId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      if (wantSession) {
        void api.session
          .search({ query: trimmed, limit: SESSION_SEARCH_LIMIT })
          .then((res) => {
            if (reqIdRef.current !== myId) return;
            setSessions({ loading: false, value: res.sessions ?? [] });
          })
          .catch(() => {
            if (reqIdRef.current !== myId) return;
            setSessions({ loading: false, value: [] });
          });
      }
      if (wantFile) {
        void api.file
          .search({ projectPath: projectPath!, query: trimmed, limit: FILE_SEARCH_LIMIT })
          .then((res) => {
            if (reqIdRef.current !== myId) return;
            setFiles({ loading: false, value: res.files ?? [] });
          })
          .catch(() => {
            if (reqIdRef.current !== myId) return;
            setFiles({ loading: false, value: [] });
          });
      }
      if (wantGrep) {
        void api.file
          .grep({
            projectPath: projectPath!,
            query: trimmed,
            limit: GREP_LIMIT,
            maxResultsPerFile: GREP_MAX_PER_FILE,
          })
          .then((res) => {
            if (reqIdRef.current !== myId) return;
            setGreps({ loading: false, value: res.matches ?? [] });
          })
          .catch(() => {
            if (reqIdRef.current !== myId) return;
            setGreps({ loading: false, value: [] });
          });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, isSearching, trimmed, scope, projectPath]);

  // Reset everything when the dialog closes so the next open is a clean slate
  // (query, scope, and all async results).
  useEffect(() => {
    if (open) return;
    setQuery("");
    setScope("all");
    setSessions(undefined);
    setFiles(undefined);
    setGreps(undefined);
    reqIdRef.current++;
  }, [open]);

  const close = () => setOpen(false);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    const store = useSessionStore.getState();
    switch (item.kind) {
      case "command":
        void item.perform(store);
        break;
      case "session": {
        const sess = item.session;
        // openTab assumes the session's project is active; switch first when
        // jumping across projects so the left-bar + config sync up.
        const run = async () => {
          if (sess.projectId !== store.activeProjectId) {
            await store.selectProject(sess.projectId);
          }
          await store.openTab(sess.id);
        };
        void run();
        break;
      }
      case "file":
        store.openFileInIde(item.file.path);
        break;
      case "grep":
        store.openFileInIde(item.match.path, {
          line: item.match.lineNumber,
          column: (item.match.matches[0]?.start ?? 0) + 1,
        });
        break;
    }
    close();
  };

  // Merge commands + async results into one ordered item list for the
  // Combobox, honouring the active scope. Commands are filtered by the query
  // locally; async results are already filtered server-side.
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const q = trimmed.toLowerCase();
    if (scopeIncludes(scope, "command")) {
      for (const cmd of commandItems) {
        if (!q || commandMatches(cmd, q)) out.push(cmd);
      }
    }
    if (isSearching) {
      if (scopeIncludes(scope, "session") && sessions && !sessions.loading) {
        for (const s of sessions.value) out.push({ kind: "session", session: s });
      }
      if (scopeIncludes(scope, "file") && files && !files.loading) {
        for (const f of files.value) out.push({ kind: "file", file: f });
      }
      if (scopeIncludes(scope, "grep") && greps && !greps.loading) {
        for (const m of greps.value) out.push({ kind: "grep", match: m });
      }
    }
    return out;
  }, [commandItems, trimmed, isSearching, scope, sessions, files, greps]);

  // Bucket items by group (preserving GROUP_ORDER) for sectioned rendering.
  const grouped = useMemo(() => {
    const buckets: Record<PaletteGroup, PaletteItem[]> = {
      command: [],
      session: [],
      file: [],
      grep: [],
    };
    for (const it of items) buckets[it.kind].push(it);
    const loadingFor: Record<PaletteGroup, boolean> = {
      command: false,
      session: scopeIncludes(scope, "session") && (sessions?.loading ?? false),
      file: scopeIncludes(scope, "file") && (files?.loading ?? false),
      grep: scopeIncludes(scope, "grep") && (greps?.loading ?? false),
    };
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: buckets[g],
      loading: loadingFor[g],
    })).filter((x) => x.items.length > 0 || x.loading);
  }, [items, scope, sessions, files, greps]);

  const totalCount = items.length;

  // ← / → cycle the active scope tab. Wired on the input's keydown so it works
  // without leaving the search field (Tab key itself is reserved by the
  // Combobox for list navigation, hence the arrow shortcut).
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // Only cycle when there's no active text caret movement to hijack; with
      // an empty query arrows do nothing useful anyway, so always cycle.
      const idx = SCOPE_TABS.findIndex((t) => t.id === scope);
      if (idx === -1) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = SCOPE_TABS[(idx + dir + SCOPE_TABS.length) % SCOPE_TABS.length];
      e.preventDefault();
      setScope(next.id);
    }
  };

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(o) => setOpen(o)}
      onOpenChangeComplete={(o) => {
        if (o) inputRef.current?.focus();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            "fixed inset-x-0 top-10 bottom-0 z-50 bg-black/50 backdrop-blur-[1px]",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity",
          )}
        />
        <BaseDialog.Popup
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 w-[min(92vw,640px)] -translate-x-1/2",
            "overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            "transition-[transform,opacity] duration-150",
          )}
        >
          <Combobox.Root<PaletteItem>
            open
            inline
            virtualized={false}
            // Commands are pre-filtered above; async results are server-filtered,
            // so the combobox filter is a no-op pass-through.
            filter={() => true}
            items={items}
            autoHighlight
            onValueChange={() => {
              /* no-op: items are one-shot actions, not selectable values */
            }}
          >
            {/* Scope tabs — pick which kind(s) to search. */}
            <ScopeTabs scope={scope} onScope={setScope} projectPath={!!projectPath} />

            {/* Search input row. Controlled so we can reset it on close. */}
            <div className="flex items-center gap-2 border-b border-edge px-3">
              <Combobox.Input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={placeholderFor(t, scope)}
                className={cn(
                  "h-11 flex-1 bg-transparent text-sm text-content",
                  "placeholder:text-content-subtle focus:outline-none",
                )}
              />
            </div>

            {/* Results list */}
            <div className="max-h-[52vh] overflow-y-auto p-1.5">
              <Combobox.List className="flex flex-col gap-1">
                {grouped.map(({ group, items: groupItems, loading }) => (
                  <Combobox.Group key={group} className="flex flex-col gap-0.5">
                    <Combobox.GroupLabel
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                        "text-content-subtle",
                      )}
                    >
                      <span>{t(GROUP_LABELS[group])}</span>
                      {loading && <IconLoader2 size={11} className="animate-spin" />}
                    </Combobox.GroupLabel>
                    {groupItems.map((item, idx) => (
                      <PaletteRow
                        key={rowKey(item, idx)}
                        item={item}
                        onClick={() => runItem(item)}
                      />
                    ))}
                  </Combobox.Group>
                ))}
                <Combobox.Empty
                  className={cn("px-3 py-8 text-center text-[13px] text-content-subtle")}
                >
                  {emptyMessageFor(t, scope, isSearching)}
                </Combobox.Empty>
              </Combobox.List>
            </div>

            {/* Footer hint */}
            <div
              className={cn(
                "flex items-center justify-between border-t border-edge px-3 py-1.5",
                "text-[10px] text-content-subtle",
              )}
            >
              <span className="flex items-center gap-2">
                <span>
                  <kbd className="rounded border border-edge px-1">↑</kbd>
                  <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>{" "}
                  {t("layout.palette.navigate")}
                </span>
                <span>
                  <kbd className="rounded border border-edge px-1">↵</kbd>{" "}
                  {t("layout.palette.run")}
                </span>
                <span>
                  <kbd className="rounded border border-edge px-1">esc</kbd>{" "}
                  {t("common.close")}
                </span>
              </span>
              <span>{t("layout.palette.resultCount", { n: totalCount })}</span>
            </div>
          </Combobox.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/* ───────────────────────── scope tabs ───────────────────────── */

/** The scope tab row. Each tab is a plain button styled to read as a segmented
 *  control; the active tab gets an accent tint. Project-scoped tabs (文件 /
 *  文件内容) are disabled when there is no active project. */
function ScopeTabs({
  scope,
  onScope,
  projectPath,
}: {
  scope: SearchScope;
  onScope: (s: SearchScope) => void;
  projectPath: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5 border-b border-edge px-2 py-1.5">
      {SCOPE_TABS.map((tab) => {
        const active = scope === tab.id;
        const disabled = tab.needsProject && !projectPath;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onScope(tab.id)}
            disabled={disabled}
            title={
              disabled
                ? t("layout.needProject")
                : t(tab.labelKey) + (tab.id === "all" ? t("layout.palette.searchAllHint") : "")
            }
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors select-none",
              active
                ? "bg-accent/12 text-accent"
                : disabled
                  ? "cursor-not-allowed text-content-subtle opacity-40"
                  : "text-content-muted hover:bg-surface-muted hover:text-content",
            )}
          >
            {t(tab.labelKey)}
          </button>
        );
      })}
      <span className="ml-auto flex items-center gap-1 text-[10px] text-content-subtle">
        <kbd className="rounded border border-edge px-1">←</kbd>
        <kbd className="rounded border border-edge px-1">→</kbd>{" "}
        {t("layout.palette.switchScope")}
      </span>
    </div>
  );
}

/** Input placeholder reflects the active scope so the user knows what they're
 *  targeting without looking up at the tabs. */
function placeholderFor(t: Translator, scope: SearchScope): string {
  switch (scope) {
    case "all":
      return t("layout.palette.placeholder.all");
    case "command":
      return t("layout.palette.placeholder.command");
    case "session":
      return t("layout.palette.placeholder.session");
    case "file":
      return t("layout.palette.placeholder.file");
    case "grep":
      return t("layout.palette.placeholder.grep");
  }
}

/** Empty-list copy tailored to the scope: with no query it prompts to type;
 *  mid-search it says there are no matches for that kind. */
function emptyMessageFor(t: Translator, scope: SearchScope, isSearching: boolean): string {
  if (!isSearching) {
    if (scope === "all" || scope === "command") return t("layout.palette.empty.command");
    if (scope === "session") return t("layout.palette.empty.session");
    if (scope === "file") return t("layout.palette.empty.file");
    return t("layout.palette.empty.grep");
  }
  return t("layout.palette.empty.searching");
}

/* ───────────────────────── helpers ───────────────────────── */

/** Stable React key for a palette row. Falls back to a kind-scoped index when
 *  the item has no natural id (keeps list reconciliation cheap and correct). */
function rowKey(item: PaletteItem, idx: number): string {
  switch (item.kind) {
    case "command":
      return `cmd:${item.id}`;
    case "session":
      return `ses:${item.session.id}`;
    case "file":
      return `file:${item.file.path}`;
    case "grep":
      return `grep:${item.match.path}:${item.match.lineNumber}:${idx}`;
  }
}

/* ───────────────────────── row renderer ───────────────────────── */

/** A single palette row. Delegates to the right inner renderer by kind so each
 *  result type shows the most useful summary (title, path, matched line…). */
function PaletteRow({ item, onClick }: { item: PaletteItem; onClick: () => void }) {
  return (
    <Combobox.Item
      value={item}
      onClick={onClick}
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
        "text-[13px] text-content",
        "data-[highlighted]:bg-accent/12 data-[highlighted]:text-content",
        "outline-none",
      )}
    >
      {item.kind === "command" ? (
        <CommandRowContent cmd={item} />
      ) : item.kind === "session" ? (
        <SessionRowContent session={item.session} />
      ) : item.kind === "file" ? (
        <FileRowContent file={item.file} />
      ) : (
        <GrepRowContent match={item.match} />
      )}
    </Combobox.Item>
  );
}

function CommandRowContent({ cmd }: { cmd: CommandDef }) {
  const Icon = cmd.icon;
  return (
    <>
      {Icon && (
        <Icon
          size={15}
          className="shrink-0 text-content-muted group-data-[highlighted]:text-accent"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
      {cmd.shortcutHint && (
        <kbd className="shrink-0 rounded border border-edge bg-surface-muted px-1 py-0.5 text-[10px] text-content-subtle">
          {cmd.shortcutHint}
        </kbd>
      )}
    </>
  );
}

function SessionRowContent({ session }: { session: Session }) {
  const { t } = useI18n();
  const title = session.title?.trim() || t("lib.untitledSession");
  const { Icon, color } = getProviderIcon(session.providerId);
  return (
    <>
      <Icon size={15} className={cn("shrink-0", color)} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </>
  );
}

function FileRowContent({ file }: { file: FileSearchEntry }) {
  return (
    <>
      <IconFile
        size={15}
        className="shrink-0 text-content-muted group-data-[highlighted]:text-accent"
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block truncate text-[11px] text-content-subtle">
          {file.relativePath}
        </span>
      </span>
    </>
  );
}

function GrepRowContent({ match }: { match: FileGrepEntry }) {
  const fileName = match.relativePath.split("/").pop() ?? match.relativePath;
  return (
    <>
      <IconFileSearch
        size={15}
        className="shrink-0 text-content-muted group-data-[highlighted]:text-accent"
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1">
          <span className="truncate font-medium">{fileName}</span>
          <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-content-subtle">
            L{match.lineNumber}
          </span>
        </span>
        <span className="block truncate font-mono text-[11px] text-content-subtle">
          <HighlightedLine line={match.lineText} matches={match.matches} />
        </span>
      </span>
    </>
  );
}

/** Renders a matched line with each query occurrence highlighted. Lifted
 *  verbatim from SearchDialog so file-content hits look identical in both
 *  surfaces. */
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
  const parts: ReactNode[] = [];
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
