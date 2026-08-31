import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { extname } from "@renderer/lib/path.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { ideDirtyTracker } from "./OpenTabsBar.js";
import { IconEye, IconEdit, IconLoader2, IconAlertTriangle, IconSquare, IconColumns3, IconPhotoOff, IconArrowLeft, IconArrowRight } from "@renderer/lib/icons.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { Markdown } from "../chat/Markdown.js";
// LSP provider bridge: registers definition/references/hover providers, syncs
// documents, and applies diagnostics markers to the model.
import {
  ensureLspProviders,
  useLspDiagnostics,
  useLspGotoActivities,
  openLspDocument,
  closeLspDocument,
  notifyLspChange,
  notifyLspSave,
  filePathToUri,
  monacoLanguageToLsp,
  LSP_LANGUAGE_DISPLAY,
  type GotoKind,
} from "@renderer/lib/lspProviders.js";
// Side-effect import: configures Monaco's worker environment + local instance
// (no CDN). Must run before any <Editor> mounts. See monacoSetup.ts.
import "@renderer/lib/monacoSetup.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { setLastCursor, type NavEntry } from "@renderer/lib/editorNav.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";

/**
 * File editor — wraps Monaco for a single open file. Supports two modes:
 *
 *  - "edit": a normal editable Monaco instance. Ctrl+S saves via
 *    `file.writeFile`. Dirty state (content diverges from last save) is
 *    reported to OpenTabsBar via `ideDirtyTracker` so the tab shows a dot.
 *
 *  - "diff": a side-by-side Monaco DiffEditor comparing the file's
 *    pre-turn `before` snapshot (from turnFilesBySession) against its current
 *    on-disk content. Read-only. Used when the user clicks 审查 on a
 *    turn-files card, or when an agent-touched file is opened.
 *
 * Mode is per-file and lives in the store (ideFileViewMode); a toggle in the
 * toolbar lets the user flip between the two when a `before` snapshot exists.
 * Files without a snapshot can only be edited (no diff to show).
 *
 * Theme follows the app's `.dark` class on <html> via a MutationObserver —
 * Monaco doesn't react to CSS, so we explicitly call `setTheme` on change.
 */
export function FileEditor({
  filePath,
  projectPath,
}: {
  filePath: string;
  projectPath: string;
}) {
  // View mode is scoped to the active project's bucket.
  const pid = useSessionStore((s) => s.activeProjectId);
  const viewMode = useSessionStore((s) =>
    pid ? s.ideFileViewModeByProject[pid]?.[filePath] ?? "edit" : "edit",
  );
  const setViewMode = useSessionStore((s) => s.setIdeFileViewMode);
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const setEditorMode = useSessionStore((s) => s.setIdeEditorMode);

  // Resolve the before-snapshot for diff mode. Three sources, in priority:
  //  1. Turn-files card override - the card's frozen `before` (passed when
  //     the user clicks a file to review). Works for HISTORICAL turns whose
  //     snapshot is gone from turnFilesBySession.
  //  2. Git panel - the active project's gitDiffByProject bucket (working-tree
  //     or history click). History pairs also carry an explicit `after` blob.
  //  3. Turn-files - the active session's latest-turn snapshot (the agent
  //     edited the file, or the user clicked 审查 on the latest turn's card).
  const turnFile = useTurnFileFor(filePath);
  const gitPair = useGitDiffPair(filePath);
  const diffBeforeOverride = useSessionStore((s) =>
    pid ? s.ideDiffBeforeByProject[pid]?.[filePath] : undefined,
  );
  const diffBefore = diffBeforeOverride ?? gitPair?.before ?? turnFile?.before;
  const diffAfter = gitPair?.after;
  // History diffs are pure blobs — don't offer switching into the live editor,
  // which would show unrelated working-tree content.
  const historyOnly = diffAfter != null;

  // Effective mode:
  //  - diff: history pairs (forced) OR explicitly requested with a snapshot.
  //  - preview: explicitly requested (Markdown rendered read-only).
  //  - edit: the normal editable Monaco instance (default for non-md files).
  const effectiveMode: "edit" | "diff" | "preview" =
    historyOnly || (viewMode === "diff" && diffBefore != null)
      ? "diff"
      : viewMode === "preview"
        ? "preview"
        : "edit";

  const markdown = isMarkdown(filePath);
  const image = isImage(filePath);
  const unsupported = isUnsupported(filePath);

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        filePath={filePath}
        projectPath={projectPath}
        mode={effectiveMode}
        canDiff={diffBefore != null && !historyOnly}
        onToggleMode={() => setViewMode(filePath, effectiveMode === "edit" ? "diff" : "edit")}
        isMarkdown={markdown}
        isImage={image}
        isUnsupported={unsupported}
        onTogglePreview={() =>
          setViewMode(filePath, effectiveMode === "preview" ? "edit" : "preview")
        }
        editorMode={editorMode}
        onToggleEditorMode={() => setEditorMode(editorMode === "tabs" ? "replace" : "tabs")}
      />
      <div className="min-h-0 flex-1">
        {effectiveMode === "diff" && diffBefore != null ? (
          <DiffPane filePath={filePath} before={diffBefore} after={diffAfter} />
        ) : effectiveMode === "preview" ? (
          image ? (
            <ImagePreviewPane filePath={filePath} />
          ) : unsupported ? (
            <UnsupportedPane filePath={filePath} />
          ) : (
            <MarkdownPreviewPane filePath={filePath} projectPath={projectPath} />
          )
        ) : (
          <EditPane filePath={filePath} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Toolbar ───────────────────────── */

/** Stable empty nav stack for zustand selectors (never return a fresh []). */
const EMPTY_NAV: NavEntry[] = [];

function EditorToolbar({
  filePath,
  projectPath,
  mode,
  canDiff,
  onToggleMode,
  isMarkdown,
  isImage,
  isUnsupported,
  onTogglePreview,
  editorMode,
  onToggleEditorMode,
}: {
  filePath: string;
  projectPath: string;
  mode: "edit" | "diff" | "preview";
  canDiff: boolean;
  onToggleMode: () => void;
  isMarkdown: boolean;
  isImage: boolean;
  isUnsupported: boolean;
  onTogglePreview: () => void;
  editorMode: "tabs" | "replace";
  onToggleEditorMode: () => void;
}) {
  const { t } = useI18n();
  // Navigation-history (Alt+←/→) back/forward state — enabled iff the active
  // project's stacks are non-empty. The buttons live here (not in a global
  // toolbar) because they act on the editor column.
  const navPid = useSessionStore((s) => s.activeProjectId);
  const canBack = useSessionStore((s) =>
    navPid ? (s.navBackByProject[navPid] ?? EMPTY_NAV).length > 0 : false,
  );
  const canForward = useSessionStore((s) =>
    navPid ? (s.navForwardByProject[navPid] ?? EMPTY_NAV).length > 0 : false,
  );
  const navigateBack = useSessionStore((s) => s.navigateBack);
  const navigateForward = useSessionStore((s) => s.navigateForward);
  // Language-server status for THIS file's language (active project's
  // workspace): "starting" shows a loading pill (jdtls can take minutes),
  // "stopped" with an error shows a failure notice that re-launches the
  // server on click (after the user fixes the environment, e.g. Java).
  // "running"/no-LSP-language show nothing.
  const lspStatus = useSessionStore((s) => {
    const lspLang = monacoLanguageToLsp(languageForExt(extname(filePath)));
    if (!lspLang) return null;
    const pid = s.activeProjectId;
    const projPath = pid ? s.projects.find((p) => p.id === pid)?.path : undefined;
    if (!projPath) return null;
    return s.lspPhasesByWorkspace[`${projPath}::${lspLang}`] ?? null;
  });
  const lspLanguageId = monacoLanguageToLsp(languageForExt(extname(filePath)));
  // Restarting guard: the `lsp:event` stateChanged stream drives the pill
  // through starting → running/stopped on its own; this flag only prevents
  // double-clicks during the brief pre-start window.
  const [restartingLsp, setRestartingLsp] = useState(false);
  const restartLsp = useCallback(async () => {
    if (!lspLanguageId || restartingLsp) return;
    const s = useSessionStore.getState();
    const pid = s.activeProjectId;
    const projPath = pid ? s.projects.find((p) => p.id === pid)?.path : undefined;
    if (!projPath) return;
    setRestartingLsp(true);
    let failure: string | undefined;
    try {
      const result = await api.lsp.restart({ workspacePath: projPath, language: lspLanguageId });
      if (!result.ok) failure = result.error;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      setRestartingLsp(false);
    }
    if (failure) {
      useToastStore.getState().push({
        kind: "error",
        title: t("ide.editor.lspRestartFailed", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] }),
        body: failure,
      });
    }
  }, [lspLanguageId, restartingLsp, t]);
  // Tooltip = label + the EFFECTIVE chord (user override or Alt+←/→ default),
  // so a rebind in settings is reflected here immediately.
  const shortcutOverrides = useSessionStore((s) => s.shortcutOverrides);
  const withChord = (commandId: string, label: string) => {
    const accel = resolveShortcut(commandId, shortcutOverrides);
    return accel ? `${label} (${acceleratorToDisplayString(accel)})` : label;
  };
  const navBackTitle = withChord("editor.nav-back", t("ide.editor.navBack"));
  const navForwardTitle = withChord("editor.nav-forward", t("ide.editor.navForward"));
  // Files that default to a read-only preview pane (markdown rendered, image
  // displayed, or an unsupported-type notice). These get a Preview/Edit toggle
  // so the user can still drop into the raw Monaco editor if they want.
  const hasPreviewToggle = isMarkdown || isImage || isUnsupported;
  // Show the path relative to the project root when possible (cleaner in the
  // narrow toolbar); fall back to the full path. Case-insensitive on Windows/
  // macOS so a lowercased drive letter from LSP (`d:\foo`) still matches a
  // project root stored with uppercase (`D:\foo`).
  const lowerFile = filePath.toLowerCase();
  const lowerProj = projectPath.toLowerCase();
  const rel =
    lowerFile.startsWith(lowerProj) && filePath.length > projectPath.length
      ? filePath.slice(projectPath.length).replace(/^[/\\]/, "")
      : filePath;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-muted/40 px-2.5 py-1">
      {/* Back/forward (navigation history) — disabled when the stacks are
          empty. Mirrors the Alt+←/→ global shortcuts. */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={navigateBack}
          disabled={!canBack}
          className={cn(
            "flex items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
            "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-subtle",
          )}
          title={navBackTitle}
        >
          <IconArrowLeft size={13} />
        </button>
        <button
          type="button"
          onClick={navigateForward}
          disabled={!canForward}
          className={cn(
            "flex items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
            "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-subtle",
          )}
          title={navForwardTitle}
        >
          <IconArrowRight size={13} />
        </button>
      </div>
      <FileTypeIcon path={filePath} size={14} className="shrink-0 text-content-subtle" />
      <span className="truncate font-mono text-[11px] text-content-muted" title={filePath}>
        {rel}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {/* Language-server startup indicator: spinner while the server's
            initialize handshake is in flight, a failure notice (click →
            settings) when it couldn't start. Requests made while starting
            wait for the server, so this pill explains the perceived lag. */}
        {lspStatus?.phase === "starting" && lspLanguageId && (
          <span
            className="flex items-center gap-1 text-[11px] text-content-subtle"
            title={t("ide.editor.lspStartingHint")}
          >
            <IconLoader2 size={11} className="animate-spin" />
            {t("ide.editor.lspStarting", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
          </span>
        )}
        {lspStatus?.phase === "importing" && lspLanguageId && (
          <span
            className="flex items-center gap-1 text-[11px] text-content-subtle"
            title={t("ide.editor.lspImportingHint")}
          >
            <IconLoader2 size={11} className="animate-spin" />
            {t("ide.editor.lspImporting", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
            {lspStatus.detail ? ` ${lspStatus.detail}` : ""}
          </span>
        )}
        {lspStatus?.phase === "stopped" && lspStatus.error && lspLanguageId && (
          <button
            type="button"
            onClick={restartLsp}
            disabled={restartingLsp}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-danger hover:bg-surface-hover",
              restartingLsp && "opacity-60",
            )}
            title={`${lspStatus.error}\n${t("ide.editor.lspRestartHint")}`}
          >
            {restartingLsp ? (
              <IconLoader2 size={11} className="animate-spin" />
            ) : (
              <IconAlertTriangle size={11} />
            )}
            {t("ide.editor.lspFailed", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
          </button>
        )}
        {canDiff && mode !== "preview" && (
          <button
            type="button"
            onClick={onToggleMode}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={mode === "edit" ? t("ide.editor.switchToDiff") : t("ide.editor.switchToEditView")}
          >
            {mode === "edit" ? <IconEye size={12} /> : <IconEdit size={12} />}
            {mode === "edit" ? "Diff" : "Edit"}
          </button>
        )}
        {/* Preview/Edit toggle - for files that default to a read-only preview
            pane (Markdown rendered, image displayed, or an unsupported-type
            notice). In preview mode the button switches to the source editor;
            in edit/diff mode it switches to the rendered preview. For binary
            files (image/unsupported) "Edit" shows raw content as Monaco sees
            it (garbled for non-utf-8) - kept as an escape hatch, not the norm. */}
        {hasPreviewToggle && (
          <button
            type="button"
            onClick={onTogglePreview}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={mode === "preview" ? t("ide.editor.switchToSource") : t("ide.editor.switchToPreview")}
          >
            {mode === "preview" ? <IconEdit size={12} /> : <IconEye size={12} />}
            {mode === "preview" ? "Edit" : "Preview"}
          </button>
        )}
        {/* Editor open-mode toggle: tabs (multi-file) ↔ replace (single-file).
            Always visible so the user can switch back to tabs even when the
            OpenTabsBar is hidden (replace mode). */}
        <button
          type="button"
          onClick={onToggleEditorMode}
          className={cn(
            "flex items-center justify-center rounded px-1 py-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
          title={
            editorMode === "tabs"
              ? t("ide.editor.modeTabsHint")
              : t("ide.editor.modeReplaceHint")
          }
        >
          {editorMode === "tabs" ? <IconColumns3 size={13} /> : <IconSquare size={13} />}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Edit pane ───────────────────────── */

/** Per-file editor view states (scroll position + cursor selection), keyed by
 *  absolute file path. App.tsx mounts FileEditor with `key={filePath}`, so
 *  every file switch tears the Monaco instance down completely — and the
 *  @monaco-editor/react built-in view-state cache only saves on a `path`
 *  change of a live editor or on unmount with `keepCurrentModel`, neither of
 *  which happens in that flow. This cache survives the remounts so re-opening
 *  a file puts the user back where they left off. */
const viewStateCache = new Map<string, editor.ICodeEditorViewState>();

/** Editable Monaco instance for one file. Loads content on mount; tracks
 *  dirty state; Ctrl+S saves. Wires LSP document sync + providers when the
 *  file's language has a server enabled. Re-opening a file restores its last
 *  scroll position / cursor from `viewStateCache`. */
function EditPane({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const { t } = useI18n();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // LSP document-sync version counter (incremented on each didChange).
  const lspVersionRef = useRef(1);
  // Debounce timer for didChange notifications.
  const changeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Editor event-listener disposables (view-state stash, cursor tracking,
  // reveal re-centering retry) — disposed on unmount.
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  // Reveal nonce consumer - re-runs when the store requests a goto-def reveal.
  const ideRevealNonce = useSessionStore((s) => s.ideRevealNonce);
  const idePendingReveal = useSessionStore((s) => s.idePendingReveal);

  // Load the file content once per filePath.
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) {
          setContent(content);
          ideDirtyTracker.set(filePath, false);
        }
      })
      .catch(() => {
        if (!cancelled) setContent(""); // degrade to empty
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Ctrl+S handler. We attach via Monaco's addCommand so it works regardless
  // of focus, and only when the editor is ready.
  const handleSave = useCallback(async () => {
    if (content === null) return;
    const editor = editorRef.current;
    if (!editor) return;
    const value = editor.getValue();
    setSaveState("saving");
    const ok = await useSessionStore.getState().saveFileContent(filePath, value);
    if (ok) {
      setContent(value); // new baseline
      ideDirtyTracker.set(filePath, false);
      setSaveState("saved");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), 1500);
      // Tell the LSP server the file was saved (best-effort).
      if (projectPath) void notifyLspSave(projectPath, filePath, language, value);
    } else {
      setSaveState("error");
    }
  }, [content, filePath]);

  const language = languageForExt(extname(filePath));

  // Theme: follow the .dark class on <html>.
  const theme = useMonacoTheme();

  // Wire Ctrl+S / Cmd+S to save + LSP providers + document open. Monaco passes
  // its monaco namespace into onMount, which is where we register the
  // keybinding (we need the monaco KeyMod/KeyCode constants to compose the
  // chord) and the LSP providers (we need the monaco.languages API).
  const handleEditorMount = (editor_: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
    editorRef.current = editor_;
    monacoRef.current = monaco;
    editor_.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave();
    });

    // Register LSP providers for this language (idempotent - once per language
    // id globally). Providers route requests through the active project's LSP
    // server via api.lsp.request.
    ensureLspProviders(monaco, language);

    // Open the document in the server (lazily starts the server if enabled).
    // If no server is enabled for this language, this is a silent no-op.
    if (projectPath) {
      void openLspDocument(projectPath, filePath, language);
    }

    // Restore the scroll position / cursor from a previous visit of this file
    // (stashed eagerly by the listeners below). A pending goto-def reveal
    // still wins — applyReveal() below runs after this and re-positions.
    const saved = viewStateCache.get(filePath);
    if (saved) editor_.restoreViewState(saved);

    // Stash the view state eagerly on every scroll / selection change. The
    // library's unmount cleanup disposes the model before any save-on-unmount
    // we could register here would run (child cleanup beats parent cleanup,
    // and saveViewState needs a live model), so an eager save is the only
    // reliable stash point across the key-remount flow.
    const stashViewState = () => {
      const vs = editor_.saveViewState();
      if (vs) viewStateCache.set(filePath, vs);
    };
    // Track the primary cursor alongside the view state (lib/editorNav): the
    // store's navigation-history actions read it to snapshot the OUTGOING
    // location when the user navigates away (Alt+← back target).
    const stashCursor = () => {
      const p = editor_.getPosition();
      if (p) setLastCursor(filePath, { line: p.lineNumber, column: p.column });
    };
    // Seed the cursor now (post view-state restore) so a file opened for the
    // first time this session still has a known location.
    stashCursor();
    editorDisposablesRef.current.push(
      editor_.onDidScrollChange(stashViewState),
      editor_.onDidChangeCursorSelection(() => {
        stashViewState();
        stashCursor();
      }),
    );

    // Apply a pending goto-def reveal now that the editor is ready. Needed for
    // cross-file jumps: the EditPane mounts, the reveal effect runs with
    // editorRef still null (onMount hasn't fired), so we must re-check here.
    applyReveal();
  };

  /** Scroll to + focus the pending reveal target for this file, if any, and
   *  clear it. Shared by the nonce effect (already-mounted editor) and
   *  onMount (freshly-mounted editor from a cross-file jump).
   *
   *  The target is revealed at the CENTER of the viewport (VS Code behavior).
   *  On the mount path the editor may still carry a degenerate layout from
   *  creation time (viewport ≈ 0–1 lines tall) — revealLineInCenter would
   *  then compute a top-aligned offset and the target lands on the FIRST
   *  visible line once automaticLayout settles. Two guards: force a
   *  synchronous layout measure before revealing, and re-assert the
   *  centering on the first post-reveal layout change (bounded to ~1s so a
   *  later user resize never jumps the scroll back). */
  const applyReveal = () => {
    const reveal = useSessionStore.getState().idePendingReveal;
    if (!reveal || reveal.filePath !== filePath) return;
    const ed = editorRef.current;
    if (!ed) return;
    const doReveal = () => {
      ed.revealLineInCenter(reveal.line);
      ed.setPosition({ lineNumber: reveal.line, column: reveal.column });
    };
    ed.layout(); // measure the container NOW so the centering math is real
    doReveal();
    ed.focus();
    useSessionStore.getState().clearIdePendingReveal();
    let retryListener: { dispose(): void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const stopRetry = () => {
      retryListener?.dispose();
      if (retryTimer) clearTimeout(retryTimer);
      retryListener = null;
      retryTimer = null;
    };
    retryListener = ed.onDidLayoutChange(() => {
      stopRetry();
      doReveal();
    });
    retryTimer = setTimeout(stopRetry, 1000);
    editorDisposablesRef.current.push({ dispose: stopRetry });
  };

  // Goto-definition reveal: when the store has a pending reveal for this file,
  // scroll to it and clear. Re-runs on the nonce bump (so a reveal into an
  // already-mounted editor works, not just on mount).
  useEffect(() => {
    applyReveal();
  }, [ideRevealNonce, idePendingReveal, filePath]);

  // LSP diagnostics subscription: applies publishDiagnostics markers to this
  // file's model and clears them on unmount.
  useLspDiagnostics(
    filePath,
    () => monacoRef.current,
    () => editorRef.current,
  );

  // Clear the saved-indicator timer, stop the editor listeners (view-state
  // stash / cursor tracking / reveal retry) + close the LSP document on
  // unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
      editorDisposablesRef.current.forEach((d) => d.dispose());
      editorDisposablesRef.current = [];
      // Report clean on unmount so a re-open doesn't show a stale dirty dot.
      ideDirtyTracker.set(filePath, false);
      // Tell the server this document closed (best-effort).
      if (projectPath) void closeLspDocument(projectPath, filePath);
    };
  }, [filePath, projectPath]);

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingFile")}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <Editor
        height="100%"
        path={filePathToUri(filePath)} // model URI = canonical file:// URI (matches LSP server)
        language={language}
        value={content}
        theme={theme}
        onChange={(value) => {
          const v = value ?? "";
          // Dirty if content diverges from the saved baseline.
          const dirty = v !== content;
          ideDirtyTracker.set(filePath, dirty);
          // Notify the LSP server of the change (debounced). The server needs
          // the full text (incremental sync isn't worth the complexity here).
          if (projectPath) {
            if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
            lspVersionRef.current += 1;
            const version = lspVersionRef.current;
            changeDebounceRef.current = setTimeout(() => {
              void notifyLspChange(projectPath, filePath, language, v, version);
            }, 300);
          }
        }}
        onMount={handleEditorMount}
        loading={<div className="text-[11px] text-content-subtle">{t("ide.editor.loadingEditor")}</div>}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          automaticLayout: true,
          renderWhitespace: "selection",
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
      {/* Save status toast — bottom-right, non-blocking. */}
      {saveState !== "idle" && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] shadow-sm",
            saveState === "saving" && "bg-surface text-content-muted",
            saveState === "saved" && "bg-accent/15 text-accent",
            saveState === "error" && "bg-danger/15 text-danger",
          )}
        >
          {saveState === "saving" && <IconLoader2 size={11} className="animate-spin" />}
          {saveState === "saved" && <span>{t("ide.editor.savedToast")}</span>}
          {saveState === "error" && (
            <>
              <IconAlertTriangle size={11} />
              {t("ide.editor.saveFailed")}
            </>
          )}
          {saveState === "saving" && t("ide.editor.saving")}
        </div>
      )}
      {/* LSP goto activity pill — bottom-center, non-blocking. */}
      <GotoActivityPill />
    </div>
  );
}

/* ──────────────────────── LSP goto activity pill ──────────────────────── */

/** Kind → label-key map for the goto pill (module-level for stable refs;
 *  `satisfies` keeps the values checkable against the i18n dictionaries). */
const GOTO_KIND_LABEL_KEY = {
  definition: "ide.editor.gotoKind.definition",
  implementation: "ide.editor.gotoKind.implementation",
  references: "ide.editor.gotoKind.references",
} as const satisfies Record<GotoKind, MessageId>;

/** Delay before a PENDING pill appears — warm sub-250ms responses shouldn't
 *  flash UI on every F12. Terminal states bypass the delay (they linger only
 *  ~1.8s, and "未找到实现" is worth showing even for fast queries). */
const GOTO_PILL_DELAY_MS = 250;
/** Show the elapsed-seconds counter once a query runs at least this long. */
const GOTO_ELAPSED_THRESHOLD_SEC = 3;

/** Floating goto-activity pill for the edit pane: a spinner + "正在查找实现…"
 *  while an LSP navigation query (F12 / Ctrl+F12 / Shift+F12) is in flight,
 *  then a brief "未找到实现" / failure notice when it lands. Cold servers
 *  (spawn + initialize + tsserver project load) can take seconds, and the
 *  cross-file path returns null to Monaco — without this pill the user has
 *  no idea whether anything is happening. */
function GotoActivityPill() {
  const { t } = useI18n();
  const activities = useLspGotoActivities();
  const latest = activities.length > 0 ? activities[activities.length - 1] : null;

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!latest || latest.state !== "pending") {
      setVisible(!!latest);
      return;
    }
    setVisible(false);
    const timer = setTimeout(() => setVisible(true), GOTO_PILL_DELAY_MS);
    return () => clearTimeout(timer);
    // Re-run when the driving activity changes (new query / state flip / the
    // lingering terminal entry dropping out of the snapshot).
  }, [latest?.id, latest?.state]);

  // Tick once per second while a pending pill is visible so the
  // elapsed-seconds counter updates.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const pending = latest?.state === "pending";
  useEffect(() => {
    if (!pending || !visible) return;
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [pending, visible]);

  if (!visible || !latest || latest.state === "done") return null;
  const elapsedSec = Math.floor((Date.now() - latest.startedAt) / 1000);
  const kind = t(GOTO_KIND_LABEL_KEY[latest.kind]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11px] shadow-sm",
        latest.state === "pending" && "bg-surface text-content-muted",
        latest.state === "empty" && "bg-surface text-content-subtle",
        latest.state === "error" && "bg-danger/15 text-danger",
      )}
    >
      {latest.state === "pending" && (
        <>
          <IconLoader2 size={11} className="animate-spin" />
          {t("ide.editor.gotoSearching", { kind })}
          {elapsedSec >= GOTO_ELAPSED_THRESHOLD_SEC && (
            <span className="text-content-subtle">{elapsedSec}s</span>
          )}
        </>
      )}
      {latest.state === "empty" && <span>{t("ide.editor.gotoNoneFound", { kind })}</span>}
      {latest.state === "error" && (
        <span className="max-w-[420px] truncate" title={latest.message}>
          {t("ide.editor.gotoFailed", { kind })}
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── Markdown preview ───────────────────────── */

/** Read-only rendered Markdown preview for `.md` files. Loads the file content
 *  via the same `file.readFile` API as EditPane, then renders it with the chat
 *  Markdown renderer (Shiki code highlighting, GFM, math). The outer container
 *  overrides `--chat-font-size` so the rendered text uses an editor-appropriate
 *  size instead of the chat bubble size. Read-only - no save / dirty tracking.
 *  Re-reads on filePath change. */
function MarkdownPreviewPane({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null); // null = loading
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) setContent(content);
      })
      .catch(() => {
        if (!cancelled) setContent(""); // degrade to empty
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingFile")}
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-surface px-6 py-4 [--chat-font-size:13px]">
      <Markdown projectPath={projectPath}>{content}</Markdown>
    </div>
  );
}

/* ───────────────────────── Image preview ───────────────────────── */

/** Read-only image preview. Fetches the file as a base64 `data:` URL via the
 *  `file.readBinary` IPC (the main process reads the bytes and enforces the
 *  project-root path guard), then renders it in an `<img>`. Centered, with a
 *  checkerboard backdrop so transparent PNGs read clearly. Zoom-to-fit by
 *  default; clicking toggles 1:1 (natural size) with scroll.
 *
 *  Uses a data URL (not a custom protocol or `file://`) so it works under the
 *  production CSP (`img-src 'self' data:`) with no extra privilege grants.
 *  No dirty tracking - images are read-only. */
function ImagePreviewPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [natural, setNatural] = useState(false);
  // null = loading, "" = error/empty, non-empty = valid data URL
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setNatural(false);
    api.file
      .readBinary({ filePath })
      .then(({ dataUrl: url }) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Loading state.
  if (dataUrl === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingImage")}
      </div>
    );
  }
  // Error / empty (refused or unreadable).
  if (!dataUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconPhotoOff size={32} className="text-content-subtle" />
        <p className="text-[12px] font-medium text-content-muted">{t("ide.editor.imageLoadFailed")}</p>
        <p className="max-w-[320px] text-[11px] leading-relaxed text-content-subtle">
          {t("ide.editor.imageLoadFailedDesc")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-auto bg-surface"
      style={{
        backgroundImage:
          "linear-gradient(45deg, var(--color-surface-muted) 25%, transparent 25%), linear-gradient(-45deg, var(--color-surface-muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-surface-muted) 75%), linear-gradient(-45deg, transparent 75%, var(--color-surface-muted) 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
      }}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center p-6"
        onClick={() => setNatural((n) => !n)}
        title={natural ? t("ide.editor.imageFitHint") : t("ide.editor.imageNaturalHint")}
      >
        <img
          src={dataUrl}
          alt={filePath}
          className={cn(
            "transition-shadow",
            natural ? "cursor-zoom-out" : "cursor-zoom-in",
            "max-h-full max-w-full object-contain shadow-lg",
          )}
          style={natural ? { maxHeight: "none", maxWidth: "none" } : undefined}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── Unsupported-file pane ───────────────────────── */

/** Friendly "can't preview" pane for binary file types the editor can't handle
 *  (Office docs, archives, binaries, audio/video, fonts, PDF). Shows the file
 *  type, a short explanation, and an "open externally" hint. Read-only, no
 *  Monaco - loading these as utf-8 would show garbled bytes. */
function UnsupportedPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const ext = extname(filePath).replace(/^\./, "").toUpperCase() || t("ide.editor.unknownExt");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconPhotoOff size={28} />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-content">
          {t("ide.editor.cannotPreview", { ext })}
        </p>
        <p className="max-w-[360px] text-[11px] leading-relaxed text-content-subtle">
          {t("ide.editor.unsupportedDesc")}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void api.shell.openFile({ path: filePath })}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface px-3 py-1.5 text-[12px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        title={t("ide.editor.openInSystemHint")}
      >
        {t("ide.editor.openInSystem")}
      </button>
    </div>
  );
}

/* ───────────────────────── Diff pane ───────────────────────── */

/** Side-by-side diff: `before` vs `after` (or current on-disk content when
 *  `after` is omitted). Read-only — the diff is for review, not editing.
 *
 *  Uses `keepCurrentOriginalModel` / `keepCurrentModifiedModel` and a manual
 *  onMount cleanup to avoid the "TextModel got disposed before
 *  DiffEditorWidget model got reset" error. The @monaco-editor/react library's
 *  default unmount disposes the TextModels BEFORE the DiffEditorWidget, which
 *  triggers the widget's model-change listener on an already-disposed model.
 *  By keeping the models alive past the widget's disposal, we break that race.
 *  We then dispose the models ourselves in the correct order (widget first,
 *  then models) via the onMount ref. */
export function DiffPane({
  filePath,
  before,
  after,
}: {
  filePath: string;
  before: string;
  /** Explicit modified-side content (history commits). When omitted the pane
   *  reads the working-tree file from disk. */
  after?: string;
}) {
  const { t } = useI18n();
  const [modified, setModified] = useState<string | null>(after ?? null);
  const theme = useMonacoTheme();
  const language = languageForExt(extname(filePath));
  // Stash the editor + monaco instances so we can dispose in the right order
  // on unmount (widget first, then models).
  const editorRef = useRef<import("monaco-editor").editor.IDiffEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  useEffect(() => {
    // History pair: both sides are already known — don't touch the disk.
    if (after != null) {
      setModified(after);
      return;
    }
    let cancelled = false;
    setModified(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) setModified(content);
      })
      .catch(() => {
        if (!cancelled) setModified("");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, after]);

  // On unmount: dispose the widget FIRST, then the models. This is the
  // reverse of what the library does by default, and avoids the listener race.
  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (editor && monaco) {
        // Dispose the diff editor widget before touching its models so no
        // model-change listener fires on a disposed model.
        try {
          editor.dispose();
        } catch {
          // already disposed — ignore
        }
      }
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  if (modified === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingDiff")}
      </div>
    );
  }

  return (
    <DiffEditor
      height="100%"
      language={language}
      original={before}
      modified={modified}
      theme={theme}
      // Prevent the library from disposing models on unmount — we handle it
      // ourselves (widget first) to avoid the dispose-order race.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<div className="text-[11px] text-content-subtle">{t("ide.editor.loadingDiff")}</div>}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        // Center column is often <900px (chat | editor split). Monaco's default
        // then collapses side-by-side into inline mode, which paints TWO line-
        // number gutters (original | modified) on a single pane — looks like a
        // duplicated 行号栏. Keep true side-by-side regardless of width.
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        // Slim gutters: no breakpoint glyph column, tighter line-number width.
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 8,
        lineNumbersMinChars: 3,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
    />
  );
}

/* ───────────────────────── hooks & helpers ───────────────────────── */

/** Look up the active session's turn-files entry for `filePath`. Returns
 *  undefined if the file wasn't touched in the latest turn (no diff). */
function useTurnFileFor(filePath: string): TurnFileEntry | undefined {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? s.turnFilesBySession[activeSessionId] : undefined,
  );
  if (!turnFiles) return undefined;
  return turnFiles.find((f) => f.filePath === filePath);
}

/** Look up the active project's git-diff pair for `filePath`.
 *  Returns undefined if the Git panel hasn't stashed a diff for this file. */
function useGitDiffPair(
  filePath: string,
): { before: string; after?: string } | undefined {
  const pid = useSessionStore((s) => s.activeProjectId);
  const projMap = useSessionStore((s) =>
    pid ? s.gitDiffByProject[pid] : undefined,
  );
  return projMap?.[filePath];
}

/** Tracks the effective Monaco theme by watching the `.dark` class on <html>
 *  and layering the user's editor color-scheme choice (Settings → 外观) on
 *  top: dark mode renders the user's dark scheme, light mode their light one
 *  (defaults "mcode-dark" / "mcode-light"). Monaco can't react to CSS, so we
 *  explicitly switch its theme when the app theme flips.
 *
 *  The switch is deferred ~150ms after the class change so it lands as the
 *  CSS theme transition (styles.css .theme-transition, 180ms) finishes —
 *  flipping instantly would flash the old palette's editor while the chrome
 *  is still fading. The MutationObserver fires on every class change (the
 *  transition flag class too), so the timeout is re-armed each time; the
 *  final arm lands after the flip settles, which is exactly what we want. */
export function useMonacoTheme(): string {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      const isDark = el.classList.contains("dark");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDark(isDark), 150);
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);
  const darkScheme = useSessionStore((s) => s.editorTheme.dark);
  const lightScheme = useSessionStore((s) => s.editorTheme.light);
  return dark ? darkScheme : lightScheme;
}

/** True for `.md` / `.markdown` files - gates the preview/edit toolbar toggle
 *  and the preview render branch. */
function isMarkdown(filePath: string): boolean {
  const ext = extname(filePath);
  return ext === ".md" || ext === ".markdown";
}

/** True for image files the editor can preview via the `app-resource://`
 *  protocol (binary files served from the main process). SVG is text but also
 *  renders as an image, so it's included. */
function isImage(filePath: string): boolean {
  switch (extname(filePath)) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".bmp":
    case ".ico":
    case ".webp":
    case ".svg":
    case ".tif":
    case ".tiff":
    case ".avif":
      return true;
    default:
      return false;
  }
}

/** True for binary file types the editor can neither edit (Monaco is text-only)
 *  nor meaningfully preview (no built-in renderer). These get a friendly
 *  "can't preview" pane instead of garbled Monaco content. Covers Office docs,
 *  archives, binaries, audio/video, and databases. */
function isUnsupported(filePath: string): boolean {
  switch (extname(filePath)) {
    // Office documents
    case ".doc":
    case ".docx":
    case ".rtf":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    // Archives
    case ".zip":
    case ".gz":
    case ".tar":
    case ".tgz":
    case ".rar":
    case ".7z":
    case ".bz2":
    case ".xz":
    // Binaries / compiled
    case ".exe":
    case ".dll":
    case ".so":
    case ".dylib":
    case ".bin":
    case ".class":
    case ".jar":
    case ".wasm":
    // Audio / video
    case ".mp3":
    case ".mp4":
    case ".webm":
    case ".avi":
    case ".mov":
    case ".ogg":
    case ".flac":
    case ".wav":
    case ".m4a":
    // Databases
    case ".db":
    case ".sqlite":
    case ".sqlite3":
    // Fonts
    case ".woff":
    case ".woff2":
    case ".ttf":
    case ".otf":
    case ".eot":
    // PDF (no built-in viewer; could add one later)
    case ".pdf":
      return true;
    default:
      return false;
  }
}

/** Map a file extension to a Monaco language id. Covers the common cases;
 *  unknown extensions fall back to plaintext (Monaco's default). */
export function languageForExt(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".html":
    case ".htm":
      return "html";
    case ".xml":
    case ".svg":
      return "xml";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "ini";
    case ".ini":
    case ".cfg":
    case ".conf":
      return "ini";
    case ".sql":
      return "sql";
    case ".dockerfile":
      return "dockerfile";
    case ".vue":
      return "html";
    default:
      return "plaintext";
  }
}
