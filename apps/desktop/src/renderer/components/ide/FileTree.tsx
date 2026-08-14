import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { basename, dirname, joinPath, relativePath } from "@renderer/lib/path.js";
import type { FileTreeEntry } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { FILE_DRAG_MIME } from "@renderer/lib/contentTag.js";
import {
  IconChevronRight,
  IconChevronDown,
  IconFolderOpen,
  IconLoader2,
  IconExternalLink,
  IconClipboard,
  IconCopy,
  IconMessage,
  IconCheck,
  IconFolderPlus,
  IconFilePlus,
  IconEdit,
  IconTrash,
  IconWorld,
} from "@renderer/lib/icons.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { localPathToFileUrl } from "@renderer/lib/browserUrl.js";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog.js";

/** Stable empty array for the expanded-dirs selector (Zustand Object.is). */
const EMPTY_EXPANDED: string[] = [];

/** Stable empty set for the rename clash check when no sibling context exists
 *  (e.g. a node rendered at the project root with no parent container). */
const EMPTY_NAMES: Set<string> = new Set();

/**
 * Registry of mounted file-node DOM buttons, keyed by absolute file path.
 * The FileTree root owns the Map and exposes a ref callback via context so
 * every FileNodeRow can register/unregister itself. Used by the reveal
 * effect to scrollIntoView the active file's node once it mounts (which may
 * be delayed while ancestor directories lazily load their children).
 */
type FileNodeRegister = (path: string, el: HTMLButtonElement | null) => void;
const FileNodeRegistryContext = createContext<FileNodeRegister | null>(null);

/** Kind of entry the inline new-entry row creates. */
type NewEntryKind = "file" | "folder";

/** Tree-wide actions exposed by the FileTree root to its descendants.
 *  `reloadSignal` is a monotonically-increasing counter that bumps each time
 *  a tree-wide re-scan is requested; DirNodes put it in their lazy-load effect
 *  deps so a bump drops their cached `children` and re-fetches. `bumpReload`
 *  increments it. The context value is memoized on the signal so consumers
 *  only re-render when it actually changes. */
interface FileTreeActions {
  reloadSignal: number;
  bumpReload: () => void;
}
const FileTreeActionsContext = createContext<FileTreeActions | null>(null);

/** The "create in my parent dir" intent surface. A DirNode (or the FileTree
 *  root) provides a handler that opens the inline new-entry row at the top of
 *  its own children list; FileNodeRow consumes it via context so a file's
 *  right-click "新建" can create a sibling without owning a children list.
 *  Null when rendered outside a container (defensive — the menu item is then
 *  a no-op). */
type StartNewInParent = (kind: NewEntryKind) => void;
const NewInParentContext = createContext<StartNewInParent | null>(null);

/** Sibling-name set provided by a container (DirNode or the FileTree root) to
 *  its direct child rows, used by the inline rename row's clash check. The set
 *  is lowercased basenames of the container's current children (memoized per
 *  load). Null when rendered outside a container — the rename clash check then
 *  falls back to server-side rejection. */
const SiblingNamesContext = createContext<Set<string> | null>(null);

/* ───────────────────────── context menu ───────────────────────── */

/** Shared popup + item classNames for the file-tree right-click menu. Mirrors
 *  the styling used by the Git panel's context menu (GitRepoCard) so the two
 *  surfaces stay visually consistent. */
const MENU_POPUP_CLASS = cn(
  "z-50 min-w-[160px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
  "transition-[transform,opacity] duration-100",
);
const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted";

/** One context-menu item with a leading icon. Keeps the per-row menus below
 *  compact and the icon+label spacing uniform. */
function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      className={cn(MENU_ITEM_CLASS, danger && "text-danger data-[highlighted]:bg-danger/10")}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </ContextMenu.Item>
  );
}

/** A horizontal divider inside a context menu. Rendered between functional
 *  groups (e.g. "new" actions vs. clipboard actions) to aid scanning. */
function MenuSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-edge" />;
}

/** The "新建文件夹 / 新建文件" pair shared by all three right-click menus
 *  (directory, file, tree blank area). Both close the menu and then invoke the
 *  supplied starter, which opens the inline new-entry row. Rendered after a
 *  {@link MenuSeparator} so they read as a distinct "create" group. */
function NewEntryMenuItems({ onStart }: { onStart: (kind: NewEntryKind) => void }) {
  return (
    <>
      <MenuItem
        icon={<IconFolderPlus size={12} />}
        label="新建文件夹"
        onClick={() => onStart("folder")}
      />
      <MenuItem
        icon={<IconFilePlus size={12} />}
        label="新建文件"
        onClick={() => onStart("file")}
      />
    </>
  );
}

/** Copy-to-clipboard with a brief inline "已复制" toast pinned to the row's
 *  top-right. Shared by the file and directory context menus. Returns the
 *  copy handler and the toast element (render once per row, near the trigger). */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const toast = copied ? (
    <div className="pointer-events-none absolute right-2 top-0 z-50 flex -translate-y-full items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-accent [font-size:var(--right-panel-font-size)] shadow-sm">
      <IconCheck size={10} />
      已复制
    </div>
  ) : null;
  return { copy, toast };
}

/* ───────────────────────── inline new-entry row ───────────────────────── */

/** Characters that are illegal in a filename on at least one platform.
 *  Rejecting them up front avoids OS-level errors from mkdir/writeFile. */
const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/;
/** Reserved Windows filenames (case-insensitive, with optional extension) —
 *  creating these is refused to match Explorer behavior. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A temporary inline input row rendered at the top of a container's children
 *  list (or the root listing) after the user picks "新建文件夹/文件". Mirrors
 *  VS Code's explorer: focus in, pre-select the logical name part, Enter to
 *  create, Esc/blur to cancel. Indentation matches sibling rows via `depth`.
 *
 *  Validation rejects empty names, path separators, reserved names, and names
 *  already present among the container's existing siblings (passed in so we
 *  don't have to re-list). On a valid name it calls the matching IPC
 *  (mkdir for folders, writeFile for files), then reports success to the
 *  parent so it can bump the tree-wide reload signal. */
function InlineNewEntryRow({
  depth,
  kind,
  parentPath,
  existingNames,
  onCancel,
  onCreated,
}: {
  depth: number;
  kind: NewEntryKind;
  /** Absolute path of the directory the new entry will live in. */
  parentPath: string;
  /** Basenames already in that directory (lowercased for a case-insensitive
   *  clash check, matching how macOS/Windows filesystems behave by default). */
  existingNames: Set<string>;
  onCancel: () => void;
  /** Called with the created entry's absolute path on success. */
  onCreated: (newPath: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Tracks an in-flight create so a second Enter doesn't double-submit.
  const submittingRef = useRef(false);

  // Autofocus + preselect on mount. For folders there's no extension, so the
  // whole placeholder is selected; for files we select up to the last dot so
  // the user can type the base name and keep the extension.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = kind === "file" ? el.value.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, [kind]);

  const create = useCallback(async () => {
    if (submittingRef.current) return;
    const name = value.trim();
    if (!name) {
      onCancel();
      return;
    }
    if (ILLEGAL_NAME_CHARS.test(name) || RESERVED_NAMES.test(name)) {
      setError("名称包含非法字符");
      return;
    }
    if (existingNames.has(name.toLowerCase())) {
      setError("同名条目已存在");
      return;
    }
    submittingRef.current = true;
    const targetPath = joinPath(parentPath, name);
    const result =
      kind === "folder"
        ? await api.file.mkdir({ dirPath: targetPath })
        : await api.file.writeFile({ filePath: targetPath, content: "" });
    submittingRef.current = false;
    if (!result.ok) {
      setError("创建失败");
      return;
    }
    onCreated(targetPath);
  }, [value, kind, parentPath, existingNames, onCancel, onCreated]);

  return (
    <div
      className="relative flex items-center gap-1 py-0.5 pr-2"
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      {/* Spacer to align the icon column with directory chevrons. */}
      <span className="w-3 shrink-0" />
      <span className="shrink-0 text-content-subtle">
        {kind === "folder" ? <IconFolderPlus size={13} /> : <IconFilePlus size={13} />}
      </span>
      <input
        ref={inputRef}
        value={value}
        // Placeholder differs by kind so the user remembers what they're making.
        placeholder={kind === "folder" ? "文件夹名称" : "文件名称"}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // Commit on blur (Enter path); cancel-only on blur if empty so an
        // accidental click-away on an untouched row doesn't error-flash.
        onBlur={() => {
          if (submittingRef.current) return;
          if (value.trim() === "") onCancel();
          else void create();
        }}
        className={cn(
          "min-w-0 flex-1 rounded border bg-surface px-1 py-0 text-content outline-none",
          "[font-size:var(--right-panel-font-size)]",
          error ? "border-danger" : "border-accent focus:border-accent",
        )}
      />
      {error && (
        <span className="pointer-events-none absolute right-2 top-0 z-10 -translate-y-full whitespace-nowrap rounded bg-danger/90 px-1.5 py-0.5 text-[10px] text-white shadow">
          {error}
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── inline rename row ───────────────────────── */

/** A temporary inline input row that replaces a node's label while renaming.
 *  Mirrors InlineNewEntryRow's UX (focus in, pre-select the logical name part,
 *  Enter to commit, Esc to cancel) but edits an existing entry instead of
 *  creating one. Validation rejects empty names, path separators, reserved
 *  names, and clashes with siblings — the entry's own current name is excluded
 *  via `excludeSelf` so renaming to itself (or just adjusting case) is allowed.
 *  On a valid name it calls `api.file.rename` (same-directory rename only,
 *  enforced server-side), then reports the new path to the parent. */
function InlineRenameRow({
  depth,
  initialName,
  isDir,
  parentPath,
  existingNames,
  excludeSelf,
  onCancel,
  onRenamed,
}: {
  depth: number;
  /** Current basename of the entry being renamed (pre-fills the input). */
  initialName: string;
  /** Whether the entry is a directory — controls name preselection. */
  isDir: boolean;
  /** Absolute path of the directory the entry lives in. */
  parentPath: string;
  /** Lowercased sibling basenames (for clash detection). */
  existingNames: Set<string>;
  /** The entry's own current name (lowercased); excluded from clash check so
   *  renaming to the same name (or a case-only change) is permitted. */
  excludeSelf: string;
  onCancel: () => void;
  /** Called with the new absolute path on success. */
  onRenamed: (newPath: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  // Tracks an in-flight rename so a second Enter doesn't double-submit.
  const submittingRef = useRef(false);

  // Autofocus + preselect on mount. For folders the whole name is selected;
  // for files we select up to the last dot so the extension is preserved.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = isDir ? -1 : el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, [isDir]);

  const commit = useCallback(async () => {
    if (submittingRef.current) return;
    const name = value.trim();
    if (!name) {
      onCancel();
      return;
    }
    if (ILLEGAL_NAME_CHARS.test(name) || RESERVED_NAMES.test(name)) {
      setError("名称包含非法字符");
      return;
    }
    // Allow a no-op / case-only rename (exclude the entry itself from clash).
    if (name.toLowerCase() !== excludeSelf && existingNames.has(name.toLowerCase())) {
      setError("同名条目已存在");
      return;
    }
    // Nothing changed — just cancel (server would reject a same-path rename).
    if (name === initialName) {
      onCancel();
      return;
    }
    submittingRef.current = true;
    const oldPath = joinPath(parentPath, initialName);
    const newPath = joinPath(parentPath, name);
    const result = await api.file.rename({ oldPath, newPath });
    submittingRef.current = false;
    if (!result.ok) {
      setError("重命名失败");
      return;
    }
    onRenamed(newPath);
  }, [value, initialName, isDir, parentPath, existingNames, excludeSelf, onCancel, onRenamed]);

  return (
    <div
      className="relative flex items-center gap-1 py-0.5 pr-2"
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      <span className="w-3 shrink-0" />
      <span className="shrink-0 text-content-subtle">
        {isDir ? <IconFolderOpen size={13} /> : <FileTypeIcon path={joinPath(parentPath, initialName)} size={13} />}
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (submittingRef.current) return;
          if (value.trim() === "") onCancel();
          else void commit();
        }}
        className={cn(
          "min-w-0 flex-1 rounded border bg-surface px-1 py-0 text-content outline-none",
          "[font-size:var(--right-panel-font-size)]",
          error ? "border-danger" : "border-accent focus:border-accent",
        )}
      />
      {error && (
        <span className="pointer-events-none absolute right-2 top-0 z-10 -translate-y-full whitespace-nowrap rounded bg-danger/90 px-1.5 py-0.5 text-[10px] text-white shadow">
          {error}
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── FileTree root ───────────────────────── */

/**
 * File tree — a lazily-loaded, expandable directory tree scoped to a single
 * project root. Root-level entries are fetched on mount; deeper levels fetch
 * on first expand. Expanded-dir state is persisted in the session store so
 * it survives restarts.
 *
 * The tree also surfaces "agent-touched" files: any file in the active
 * session's `turnFilesBySession` gets a colored dot so the user can spot
 * what the agent just changed without scanning every node.
 */
export function FileTree({ projectPath }: { projectPath: string }) {
  const pid = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setDirExpanded = useSessionStore((s) => s.setDirExpanded);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  // Root-level listing. Refetched when the project root changes (different
  // active session -> different project) OR when `reloadSignal` bumps (a
  // descendant created/deleted an entry and asked the tree to re-scan).
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadSignal, setReloadSignal] = useState(0);
  const bumpReload = useCallback(() => setReloadSignal((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.file
      .listDir({ projectPath, dirPath: "" })
      .then(({ entries }) => {
        if (!cancelled) {
          setEntries(entries);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, reloadSignal]);

  // Root-level inline new-entry row, opened by the blank-area context menu.
  // Lives at the top of the entries list (depth 0 == project root). After a
  // successful create we bump the reload signal to re-scan the root.
  const [creating, setCreating] = useState<NewEntryKind | null>(null);
  const startCreating = useCallback((kind: NewEntryKind) => setCreating(kind), []);
  const handleCreated = useCallback(
    (newPath: string) => {
      const wasFile = creating === "file";
      setCreating(null);
      bumpReload();
      // Open files in the center editor (VS Code parity); folders just appear.
      if (wasFile) openFileInIde(newPath);
    },
    [bumpReload, creating, openFileInIde],
  );

  // Registry of mounted file-node buttons, used by the reveal effect below.
  // useRef (not state) so register/unregister never triggers a re-render; the
  // reveal effect polls it via rAF. Cleared implicitly on remount
  // (key={projectPath} in FilesPanel).
  const nodeMap = useRef<Map<string, HTMLButtonElement>>(new Map());
  const registerNode = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el) nodeMap.current.set(path, el);
    else nodeMap.current.delete(path);
  }, []);

  // Reveal the active file in the tree: expand its ancestor dirs (so the node
  // mounts - DirNode only renders children when open) then scroll it into view.
  // Ancestor expansion is an async chain (setDirExpanded -> re-render ->
  // DirNode lazy-loads children -> child mounts), so we can't scroll
  // synchronously; we poll the node registry across rAF frames until the node
  // appears (or give up after ~500ms).
  useEffect(() => {
    if (!activeFile || !activeFile.startsWith(projectPath)) return;
    // Build the ancestor dir chain from the file's dir up to (excluding) the
    // project root. E.g. "D:/proj/src/sub/a.ts" + root "D:/proj" ->
    // ["D:/proj/src", "D:/proj/src/sub"] (shallow-to-deep). We expand
    // shallow-first so each level's lazy load can kick off in mount order.
    const ancestors: string[] = [];
    let dir = dirname(activeFile);
    while (dir && dir !== projectPath) {
      // Guard: if dirname stops making progress (filesystem root), stop.
      ancestors.unshift(dir); // prepend -> shallowest first
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const ancestor of ancestors) {
      setDirExpanded(ancestor, true);
    }

    let frames = 0;
    const MAX_FRAMES = 30; // ~500ms @60fps - enough for a few async dir loads
    let raf = 0;
    const tryScroll = () => {
      const node = nodeMap.current.get(activeFile);
      if (node) {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (++frames < MAX_FRAMES) {
        raf = requestAnimationFrame(tryScroll);
      }
      // else: ancestors still loading after the budget - give up silently.
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [activeFile, projectPath, setDirExpanded]);

  // Precompute lowercased sibling names for the root-level clash check so the
  // InlineNewEntryRow gets a stable Set (no per-render allocation in the row).
  // MUST run before the `loading` early-return below: useMemoLowercasedNames
  // wraps useMemo, and the Rules of Hooks require the same hooks in the same
  // order on every render. Calling it while loading is harmless — `entries`
  // is [] then, so it just memoizes an empty Set.
  const rootNames = useMemoLowercasedNames(entries);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-content-subtle [font-size:var(--rp-fs-xs)]">
        <IconLoader2 size={12} className="animate-spin" />
        读取目录…
      </div>
    );
  }

  // The blank-area context menu (new file/folder at the project root) wraps
  // the whole tree body, including the empty-directory case so a brand-new
  // project can still create its first entry via right-click.
  const treeBody = (
    <div className="min-h-full py-1 [font-size:var(--right-panel-font-size)]">
      {creating && (
        <InlineNewEntryRow
          depth={0}
          kind={creating}
          parentPath={projectPath}
          existingNames={rootNames}
          onCancel={() => setCreating(null)}
          onCreated={handleCreated}
        />
      )}
      {entries.length === 0 && !creating ? (
        <div className="px-3 py-2 text-content-subtle [font-size:var(--rp-fs-xs)]">
          空目录
        </div>
      ) : (
        <SiblingNamesContext.Provider value={rootNames}>
          {entries.map((e) => (
            <TreeNode key={e.path} entry={e} depth={0} projectPath={projectPath} />
          ))}
        </SiblingNamesContext.Provider>
      )}
    </div>
  );

  return (
    <FileNodeRegistryContext.Provider value={registerNode}>
      <FileTreeActionsContext.Provider value={{ reloadSignal, bumpReload }}>
        {/* NewInParentContext at the root level: a file row whose nearest
            container IS the project root forwards "新建" here, opening the
            root-level inline row. Deeper DirNodes override this provider. */}
        <NewInParentContext.Provider value={startCreating}>
          <ContextMenu.Root>
            <ContextMenu.Trigger
              render={<div className="min-h-full" />}
            >
              {treeBody}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner>
                <ContextMenu.Popup className={MENU_POPUP_CLASS}>
                  <NewEntryMenuItems onStart={startCreating} />
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </NewInParentContext.Provider>
      </FileTreeActionsContext.Provider>
    </FileNodeRegistryContext.Provider>
  );
}

/** Build a lowercased Set of entry basenames for the InlineNewEntryRow clash
 *  check. Memoized so the row receives a stable reference across re-renders. */
function useMemoLowercasedNames(entries: FileTreeEntry[]): Set<string> {
  return useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.name.toLowerCase());
    return set;
  }, [entries]);
}

/** Maximum number of single-subdir levels to absorb into one row. Caps a
 *  pathological deep chain so the compact loop can't block the renderer. */
const MAX_COMPACT_DEPTH = 24;

/** Load `startPath`'s entries, then keep descending as long as the dir has
 *  exactly one entry and it's a subdir, absorbing each step into a compact
 *  chain (VS Code "Compact Folders"). Returns the end dir's absolute path, the
 *  absorbed name segments (excluding startPath's own name), and the end dir's
 *  entries. */
async function loadAndCompact(
  projectPath: string,
  startPath: string,
): Promise<{
  endPath: string;
  extraSegments: string[];
  children: FileTreeEntry[];
}> {
  const extraSegments: string[] = [];
  let currentPath = startPath;
  let entries: FileTreeEntry[] = [];
  for (let i = 0; i < MAX_COMPACT_DEPTH; i++) {
    // dirPath is relative to projectPath; compute it from the absolute path
    // (same trick the old lazy-load used).
    const dirPath = currentPath.slice(projectPath.length).replace(/^[\\/]/, "");
    const result = await api.file.listDir({ projectPath, dirPath });
    entries = result.entries;
    // Compact only when there's exactly one entry and it's a directory.
    if (entries.length === 1 && entries[0].isDir) {
      extraSegments.push(entries[0].name);
      currentPath = entries[0].path;
    } else {
      break;
    }
  }
  return { endPath: currentPath, extraSegments, children: entries };
}

/* ───────────────────────── TreeNode ───────────────────────── */

/** One node in the tree — either a directory (expandable, lazy-loads children)
 *  or a file (clickable, opens in the editor). Indentation is driven by
 *  `depth` via inline padding-left so the tree needs no nested DOM for
 *  alignment. */
function TreeNode({
  entry,
  depth,
  projectPath,
}: {
  entry: FileTreeEntry;
  depth: number;
  projectPath: string;
}) {
  // Expanded dirs + active file are scoped to the active project.
  const pid = useSessionStore((s) => s.activeProjectId);
  const expandedDirs = useSessionStore((s) =>
    pid ? s.ideExpandedDirsByProject[pid] ?? EMPTY_EXPANDED : EMPTY_EXPANDED,
  );
  const toggleDirExpanded = useSessionStore((s) => s.toggleDirExpanded);
  const setDirExpanded = useSessionStore((s) => s.setDirExpanded);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );

  const isOpen = expandedDirs.includes(entry.path);
  const isActiveFile = activeFile === entry.path;

  if (entry.isDir) {
    return (
      <DirNode
        entry={entry}
        depth={depth}
        projectPath={projectPath}
        isOpen={isOpen}
        onToggle={() => toggleDirExpanded(entry.path)}
        setDirExpanded={setDirExpanded}
      />
    );
  }

  return (
    <FileNodeRow
      name={entry.name}
      path={entry.path}
      depth={depth}
      active={isActiveFile}
      onClick={() => openFileInIde(entry.path)}
      projectPath={projectPath}
    />
  );
}

/** Directory node — toggles expansion; children load lazily on first open.
 *  Directories stay collapsed until the user clicks them (no auto-open of
 *  single-level subdir chains); the active-file reveal effect below expands
 *  ancestors programmatically instead.
 *
 *  Owns the inline new-entry row for its own children list: the "新建" menu
 *  items (from this dir's context menu OR from a child file's menu, via
 *  {@link NewInParentContext}) open a {@link InlineNewEntryRow} at the top of
 *  the children. On create it bumps the tree-wide reload signal so the new
 *  entry re-renders as a real node. */
function DirNode({
  entry,
  depth,
  projectPath,
  isOpen,
  onToggle,
  setDirExpanded,
}: {
  entry: FileTreeEntry;
  depth: number;
  projectPath: string;
  isOpen: boolean;
  onToggle: () => void;
  setDirExpanded: (dirPath: string, open: boolean) => void;
}) {
  // Tree-wide reload signal: a bump means a sibling/dir was created or
  // deleted somewhere, so drop this node's cached children and re-fetch.
  const actions = useContext(FileTreeActionsContext);
  const reloadSignal = actions?.reloadSignal ?? 0;
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  const [children, setChildren] = useState<FileTreeEntry[] | null>(null);
  const [extraSegments, setExtraSegments] = useState<string[]>([]);
  const [endPath, setEndPath] = useState<string>(entry.path);
  const [loading, setLoading] = useState(false);
  // Inline new-entry row state: null = hidden, "file"|"folder" = showing.
  const [creating, setCreating] = useState<NewEntryKind | null>(null);
  // Inline rename mode: when true the directory label is replaced by an input.
  const [renaming, setRenaming] = useState(false);
  // Pending delete confirmation dialog state.
  const [pendingDelete, setPendingDelete] = useState(false);
  const { copy: copyWithFeedback, toast: copiedToast } = useCopyFeedback();
  const closeFilesUnderDir = useSessionStore((s) => s.closeFilesUnderDir);
  const renamePathInIde = useSessionStore((s) => s.renamePathInIde);
  // In-flight delete guard so a double-confirm can't fire twice.
  const deletingRef = useRef(false);

  // Track the last reload signal we acted on so we can diff and force a
  // re-load even when `children` is already cached (the normal guard would
  // skip re-fetch once children is non-null).
  const lastReloadRef = useRef(reloadSignal);

  // Lazy-load + compact when first expanded, and re-load when the tree-wide
  // reload signal bumps (a create/delete happened). On a forced reload we
  // bypass the `children !== null` cache guard by comparing the signal to the
  // last-seen value.
  useEffect(() => {
    if (!isOpen) return;
    // Skip work if children are loaded AND the signal hasn't moved since.
    if (children !== null && reloadSignal === lastReloadRef.current) return;
    lastReloadRef.current = reloadSignal;
    let cancelled = false;
    setLoading(true);
    loadAndCompact(projectPath, entry.path)
      .then(({ endPath: ep, extraSegments: segs, children: kids }) => {
        if (cancelled) return;
        setChildren(kids);
        setExtraSegments(segs);
        setEndPath(ep);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setChildren([]);
        setExtraSegments([]);
        setEndPath(entry.path);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `children` intentionally omitted: including it would re-run on every
    // successful load (setChildren) and cancel the in-flight request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, entry.path, projectPath, reloadSignal]);

  // If the active file lives under endPath (the compacted dir), make sure
  // endPath is in the store's expandedDirs so the reveal effect can descend.
  // Compaction means the intermediate dirs in the chain don't have their own
  // DirNode rows, so the store wouldn't otherwise know to expand them.
  const activeFile = useSessionStore((s) => {
    const pid = s.activeProjectId;
    return pid ? s.ideActiveFileByProject[pid] ?? null : null;
  });
  useEffect(() => {
    if (!activeFile) return;
    if (endPath !== entry.path && activeFile.startsWith(endPath + "/")) {
      setDirExpanded(endPath, true);
    }
  }, [activeFile, endPath, entry.path, setDirExpanded]);

  // Build the display label: entry.name + absorbed segments, joined by "/".
  // e.g. entry.name="apps", extraSegments=["desktop","src"] -> "apps/desktop/src".
  const label =
    extraSegments.length > 0 ? `${entry.name}/${extraSegments.join("/")}` : entry.name;

  // Open the inline new-entry row. Expands the dir first so the row (rendered
  // inside the children block) is visible; children lazy-load in parallel.
  const startCreating = useCallback(
    (kind: NewEntryKind) => {
      if (!isOpen) onToggle();
      setCreating(kind);
    },
    [isOpen, onToggle],
  );

  const handleCreated = useCallback(
    (newPath: string) => {
      setCreating(null);
      actions?.bumpReload();
      if (creating === "file") openFileInIde(newPath);
    },
    [actions, creating, openFileInIde],
  );

  // Rename the directory. On success: exit rename mode, re-scan the tree, and
  // migrate any editor state (open tabs / expanded dirs) keyed under the old
  // path to the new one so nothing dangles.
  const handleRenamed = useCallback(
    (newPath: string) => {
      setRenaming(false);
      actions?.bumpReload();
      renamePathInIde(endPath, newPath, true);
    },
    [actions, endPath, renamePathInIde],
  );

  // Confirm-approved delete: trash the dir, re-scan, and close any editor tabs
  // that lived under it. Guarded so a re-confirm can't double-fire.
  const handleDelete = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    const result = await api.file.delete({ targetPath: endPath });
    deletingRef.current = false;
    if (!result.ok) return;
    actions?.bumpReload();
    closeFilesUnderDir(endPath);
  }, [actions, endPath, closeFilesUnderDir]);

  // Lowercased child names for the inline row's clash check (stable per load).
  const childNames = useMemo(() => {
    const set = new Set<string>();
    if (children) for (const c of children) set.add(c.name.toLowerCase());
    return set;
  }, [children]);

  // This dir's own siblings (provided by the parent container) — used by the
  // rename row to detect a name clash with a sibling dir/file. Null at the root
  // (no parent container); falls back to server-side rejection.
  const siblingNames = useContext(SiblingNamesContext);

  return (
    <div className="relative">
      {/* Provide a "create sibling" handler to descendant file rows so their
          right-click "新建" routes here (into this dir's children list). */}
      <NewInParentContext.Provider value={startCreating}>
        {renaming ? (
          // Rename mode replaces the label row with an inline input. Use the
          // real leaf basename of endPath (handles compact-folders where
          // entry.name is only the first segment).
          <InlineRenameRow
            depth={depth}
            initialName={basename(endPath)}
            isDir
            parentPath={dirname(endPath)}
            existingNames={siblingNames ?? EMPTY_NAMES}
            excludeSelf={basename(endPath).toLowerCase()}
            onCancel={() => setRenaming(false)}
            onRenamed={handleRenamed}
          />
        ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger
            render={
              <button
                type="button"
                onClick={onToggle}
                className={cn(
                  "flex w-full items-center gap-1 py-0.5 pr-2 text-left transition-colors hover:bg-surface-hover/50",
                )}
                style={{ paddingLeft: depth * 12 + 4 }}
              />
            }
          >
            <span className="shrink-0 text-content-subtle">
              {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            </span>
            <span className="shrink-0 text-content-subtle">
              <IconFolderOpen size={13} />
            </span>
            <span className="truncate text-content-muted">{label}</span>
            {loading && <IconLoader2 size={10} className="ml-auto animate-spin text-content-subtle" />}
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner>
              <ContextMenu.Popup className={MENU_POPUP_CLASS}>
                <MenuItem
                  icon={<IconFolderOpen size={12} />}
                  label={isOpen ? "折叠" : "展开"}
                  onClick={onToggle}
                />
                <MenuSeparator />
                <NewEntryMenuItems onStart={startCreating} />
                <MenuSeparator />
                <MenuItem
                  icon={<IconExternalLink size={12} />}
                  label="在资源管理器中显示"
                  onClick={() => void api.shell.showItemInFolder({ path: endPath })}
                />
                <MenuItem
                  icon={<IconClipboard size={12} />}
                  label="复制绝对路径"
                  onClick={() => copyWithFeedback(endPath)}
                />
                <MenuItem
                  icon={<IconCopy size={12} />}
                  label="复制相对路径"
                  onClick={() => copyWithFeedback(relativePath(endPath, projectPath))}
                />
                <MenuSeparator />
                <MenuItem
                  icon={<IconEdit size={12} />}
                  label="重命名"
                  onClick={() => setRenaming(true)}
                />
                <MenuItem
                  icon={<IconTrash size={12} />}
                  label="删除"
                  danger
                  onClick={() => setPendingDelete(true)}
                />
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        )}
        {copiedToast}
        <ConfirmDialog
          open={pendingDelete}
          title="删除文件夹"
          description={
            <>
              确定要删除 <span className="text-content">{label}</span> 吗?
              <br />
              <span className="text-content-subtle">文件夹及其所有内容将移至回收站,可从系统回收站恢复。</span>
            </>
          }
          confirmText="删除"
          danger
          onOpenChange={(open) => {
            if (!open) setPendingDelete(false);
          }}
          onConfirm={() => void handleDelete()}
        />
        {isOpen && children && (
          <div>
            {creating && (
              <InlineNewEntryRow
                depth={depth + 1}
                kind={creating}
                parentPath={endPath}
                existingNames={childNames}
                onCancel={() => setCreating(null)}
                onCreated={handleCreated}
              />
            )}
            <SiblingNamesContext.Provider value={childNames}>
              {children.map((c) => (
                <TreeNode key={c.path} entry={c} depth={depth + 1} projectPath={projectPath} />
              ))}
            </SiblingNamesContext.Provider>
          </div>
        )}
      </NewInParentContext.Provider>
    </div>
  );
}

/** File node row — shared by the top-level listing and nested children. Shows
 *  an agent-touched marker if this file is in the active session's turn-files. */
function FileNodeRow({
  name,
  path,
  depth,
  active,
  onClick,
  projectPath,
}: {
  name: string;
  path: string;
  depth: number;
  active: boolean;
  onClick: () => void;
  projectPath: string;
}) {
  // Agent-touched marker: look up this file in the active session's turn-files.
  const turnFile = useAgentTouchedFile(path);
  // Register this button with the FileTree's node registry so the reveal
  // effect can scrollIntoView it once mounted (may be delayed while ancestor
  // dirs lazily load). Null when rendered outside a FileTree (defensive).
  const registerNode = useContext(FileNodeRegistryContext);
  // "Create sibling" intent surface: opens the inline new-entry row in the
  // nearest container (the file's parent dir). Null outside a FileTree.
  const startNewInParent = useContext(NewInParentContext);
  const { copy: copyWithFeedback, toast: copiedToast } = useCopyFeedback();
  const enqueueChatFile = useSessionStore((s) => s.enqueueChatFile);
  // Tree-wide reload signal — used to re-scan after rename/delete. Null when
  // rendered outside a FileTree (the menu items are then hidden anyway).
  const actions = useContext(FileTreeActionsContext);
  // Sibling names (lowercased) for the rename clash check; provided by the
  // containing DirNode / FileTree root. Null outside a tree.
  const siblingNames = useContext(SiblingNamesContext);
  const closeFileInIde = useSessionStore((s) => s.closeFileInIde);
  const renamePathInIde = useSessionStore((s) => s.renamePathInIde);
  // Inline rename mode and pending-delete confirmation dialog.
  const [renaming, setRenaming] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  // In-flight delete guard so a double-confirm can't fire twice.
  const deletingRef = useRef(false);

  const handleRenamed = useCallback(
    (newPath: string) => {
      setRenaming(false);
      actions?.bumpReload();
      renamePathInIde(path, newPath, false);
    },
    [actions, path, renamePathInIde],
  );

  const handleDelete = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    const result = await api.file.delete({ targetPath: path });
    deletingRef.current = false;
    if (!result.ok) return;
    actions?.bumpReload();
    closeFileInIde(path);
  }, [actions, path, closeFileInIde]);

  return (
    <div className="relative">
      {renaming ? (
        <InlineRenameRow
          depth={depth}
          initialName={name}
          isDir={false}
          parentPath={dirname(path)}
          existingNames={siblingNames ?? EMPTY_NAMES}
          excludeSelf={name.toLowerCase()}
          onCancel={() => setRenaming(false)}
          onRenamed={handleRenamed}
        />
      ) : (
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <button
              type="button"
              ref={registerNode ? (el) => registerNode(path, el) : undefined}
              draggable
              onDragStart={(e) => {
                // Stash the file path in a custom MIME type so the composer's drop
                // handler can read it. effectAllowed=copy signals "this creates a
                // new reference" (not a move).
                e.dataTransfer.setData(FILE_DRAG_MIME, path);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={onClick}
              className={cn(
                "flex w-full items-center gap-1 py-0.5 pr-2 text-left transition-colors",
                active ? "bg-accent/15 text-content" : "text-content-muted hover:bg-surface-hover/50",
              )}
              style={{ paddingLeft: depth * 12 + 4 }}
              title={path}
            />
          }
        >
          {/* Spacer to align with directory chevrons. */}
          <span className="w-3 shrink-0" />
          <span className="shrink-0 text-content-subtle">
            <FileTypeIcon path={path} size={13} />
          </span>
          <span className="truncate">{name}</span>
          {/* Agent-touched dot: accent for created, danger-ish for modified. */}
          {turnFile && (
            <span
              className={cn(
                "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                turnFile.kind === "created" ? "bg-accent" : "bg-info",
              )}
              title={turnFile.kind === "created" ? "本轮新建" : "本轮修改"}
            />
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner>
            <ContextMenu.Popup className={MENU_POPUP_CLASS}>
              <MenuItem icon={<FileTypeIcon path={path} size={12} />} label="打开" onClick={onClick} />
              {/* "新建" creates a sibling in this file's parent dir; only shown
                  when a container context is available (i.e. inside a tree). */}
              {startNewInParent && (
                <>
                  <MenuSeparator />
                  <NewEntryMenuItems onStart={startNewInParent} />
                </>
              )}
              <MenuSeparator />
              <MenuItem
                icon={<IconExternalLink size={12} />}
                label="在资源管理器中显示"
                onClick={() => void api.shell.showItemInFolder({ path })}
              />
              <MenuItem
                icon={<IconClipboard size={12} />}
                label="复制绝对路径"
                onClick={() => copyWithFeedback(path)}
              />
              <MenuItem
                icon={<IconCopy size={12} />}
                label="复制相对路径"
                onClick={() => copyWithFeedback(relativePath(path, projectPath))}
              />
              <MenuItem
                icon={<IconMessage size={12} />}
                label="添加到聊天"
                onClick={() => enqueueChatFile(path)}
              />
              {/\.html?$/i.test(path) && (
                <MenuItem
                  icon={<IconWorld size={12} />}
                  label="在浏览器中打开"
                  onClick={() =>
                    useSessionStore.getState().openUrlInBrowser(localPathToFileUrl(path))
                  }
                />
              )}
              <MenuSeparator />
              <MenuItem
                icon={<IconEdit size={12} />}
                label="重命名"
                onClick={() => setRenaming(true)}
              />
              <MenuItem
                icon={<IconTrash size={12} />}
                label="删除"
                danger
                onClick={() => setPendingDelete(true)}
              />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      )}
      {copiedToast}
      <ConfirmDialog
        open={pendingDelete}
        title="删除文件"
        description={
          <>
            确定要删除 <span className="text-content">{name}</span> 吗?
            <br />
            <span className="text-content-subtle">文件将移至回收站,可从系统回收站恢复。</span>
          </>
        }
        confirmText="删除"
        danger
        onOpenChange={(open) => {
          if (!open) setPendingDelete(false);
        }}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

/* ───────────────────────── agent-touched hook ───────────────────────── */

/** Returns the TurnFileEntry for `path` if it's among the active session's
 *  most-recent-turn files, else undefined. Used to mark tree nodes. */
function useAgentTouchedFile(path: string): TurnFileEntry | undefined {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? s.turnFilesBySession[activeSessionId] : undefined,
  );
  if (!turnFiles) return undefined;
  return turnFiles.find((f) => f.filePath === path);
}
