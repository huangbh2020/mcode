/**
 * Monaco language-provider bridge for LSP.
 *
 * Registers `definition`, `references`, and `hover` providers on Monaco
 * language ids; each provider forwards the request to the main-process
 * `LspManager` via `api.lsp.request` and translates the LSP response back into
 * Monaco types. Also exposes a diagnostics hook that subscribes to the
 * `lsp:event` push channel and applies `publishDiagnostics` to the model.
 *
 * Coordinate convention: LSP positions are 0-based (line/character); Monaco
 * positions are 1-based (lineNumber/column). Every conversion happens here so
 * the rest of the editor never sees LSP coordinates.
 *
 * Providers are registered once per language id (Monaco dedupes), guarded by a
 * module-level Set so re-mounting EditPane doesn't double-register. Each
 * registration returns an `IDisposable`; we keep them for the app lifetime
 * (cheap - they just hold a closure).
 */
import type { editor, languages, IDisposable, IRange, MarkerSeverity, Uri } from "monaco-editor";
import type { LspDiagnostic, LspLanguageId } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import { useEffect, useRef, useSyncExternalStore } from "react";

/** Map a Monaco language id to the LSP language id we route requests through.
 *  TS server handles both typescript + javascript, so both map to "typescript".
 *  Exported so the editor toolbar can resolve a file's LSP language for the
 *  server-status indicator. */
export function monacoLanguageToLsp(languageId: string): LspLanguageId | null {
  switch (languageId) {
    case "typescript":
    case "javascript":
      return "typescript";
    case "python":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    default:
      return null;
  }
}

/** Display names for the LSP language ids (proper nouns — same in zh/en, so
 *  they bypass the i18n dictionaries). */
export const LSP_LANGUAGE_DISPLAY: Record<LspLanguageId, string> = {
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  java: "Java",
};

/** Languages we've already registered providers for (Monaco registers per
 *  language id globally, not per model). */
const registeredLanguages = new Set<string>();

/** Disposers for all registered providers (kept for app lifetime). */
const providerDisposers: IDisposable[] = [];

/** Diff panes show ANONYMOUS Monaco models (inmemory://model/N) — the LSP
 *  server only knows real file:// URIs, so requests arriving from a diff
 *  model need the model→file mapping below. Keyed by model URI string;
 *  DiffPane binds on mount / file switch and unbinds on unmount. */
const modelPathBindings = new Map<string, string>();

/** Bind an anonymous model (typically one of DiffPane's two sides) to the
 *  real file it displays, so LSP requests can address the file. */
export function bindModelToPath(model: { uri: Uri }, filePath: string): void {
  modelPathBindings.set(model.uri.toString(), filePath);
}

/** Release a binding established by `bindModelToPath`. Safe on unknown models
 *  (no-op) — models may already be gone at cleanup time. */
export function unbindModel(model: { uri: Uri } | null | undefined): void {
  if (model) modelPathBindings.delete(model.uri.toString());
}

/** Register definition/references/hover providers for `languageId` if not
 *  already registered. Returns nothing; disposers are retained internally. */
export function ensureLspProviders(
  monaco: typeof import("monaco-editor"),
  languageId: string,
): void {
  if (registeredLanguages.has(languageId)) return;
  const lspLang = monacoLanguageToLsp(languageId);
  if (!lspLang) return;
  registeredLanguages.add(languageId);

  /** Resolve the workspace root for the currently-active project. The LSP
   *  server was spawned with this root; requests must carry it so the manager
   *  routes to the right server. */
  const workspacePath = (): string | null => {
    // Follows the active session's environment: worktree sessions get an
    // LSP workspace rooted at their isolated checkout (a fresh import for
    // jdtls; cheap for TS servers).
    return selectActiveEnvPath(useSessionStore.getState());
  };

  /** Forward an LSP request to main. Throws on failure (no active project,
   *  server not enabled/installed, transport error) so the caller can decide
   *  whether to surface it — the goto providers turn it into the activity
   *  pill's error state; hover swallows it silently. */
  const lspRequest = async (method: string, params: unknown): Promise<unknown> => {
    const wp = workspacePath();
    if (!wp) throw new Error("no active project");
    const res = await api.lsp.request({
      workspacePath: wp,
      language: lspLang,
      method,
      params,
    });
    if ("error" in res) {
      // The server may not support this method; log for debugging.
      console.debug(`lsp.request ${method} failed:`, res.error.message);
      throw new Error(res.error.message);
    }
    return res.result;
  };

  // textDocument/definition. When the target is in a different file, we open
  // it via the store (which mounts the EditPane + reveals the line) and return
  // null so Monaco doesn't try to navigate to a model that doesn't exist yet.
  // When the target is the same file, we return the Location so Monaco handles
  // the in-file scroll natively (smoother, keeps cursor history).
  providerDisposers.push(
    monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model, position) => {
        const docUri = modelToLspUri(model);
        const activity = lspGotoTracker.begin("definition");
        try {
          const result = await lspRequest("textDocument/definition", {
            textDocument: { uri: docUri },
            position: toLspPosition(position),
          });
          const locs = toMonacoLocations(result, monaco);
          if (!locs || locs.length === 0) {
            lspGotoTracker.end(activity, "empty");
            return null;
          }
          // Extract the path from the RAW LSP result (not from Monaco's Uri,
          // which lowercases the Windows drive letter). This preserves the
          // original case so openFileInIde's path matches the store.
          const currentPath = uriToFilePath(decodeURIComponentSafe(docUri));
          const firstRaw = firstRawLocation(result);
          if (firstRaw) {
            const targetPath = uriToFilePath(decodeURIComponentSafe(firstRaw.uri));
            if (targetPath !== currentPath) {
              // Cross-file: open via the store (which records the outgoing
              // location into the navigation history itself).
              gotoLocation(
                targetPath,
                firstRaw.range.start.line + 1,
                firstRaw.range.start.character + 1,
              );
              lspGotoTracker.end(activity, "done");
              return null;
            }
          }
          // Same-file (or raw extraction failed): return locations so Monaco
          // navigates natively. Locations pointing at this file are rewritten
          // onto the model's own URI (a no-op in the edit pane; in the diff
          // pane this is what makes in-pane jumps work at all). Monaco's jump
          // bypasses the store, so record the pre-jump position here for
          // Alt+← (navigation history).
          useSessionStore.getState().pushNavHistory({
            filePath: currentPath,
            line: position.lineNumber,
            column: position.column,
          });
          lspGotoTracker.end(activity, "done");
          return rewriteToModelUri(locs, model, currentPath);
        } catch (err) {
          lspGotoTracker.end(
            activity,
            "error",
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }
      },
    }),
  );

  // textDocument/references
  providerDisposers.push(
    monaco.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, position) => {
        const activity = lspGotoTracker.begin("references");
        try {
          const result = await lspRequest("textDocument/references", {
            textDocument: { uri: modelToLspUri(model) },
            position: toLspPosition(position),
            context: { includeDeclaration: true },
          });
          const locs = toMonacoLocations(result, monaco);
          lspGotoTracker.end(activity, locs && locs.length > 0 ? "done" : "empty");
          if (!locs) return null;
          // Same-file references are rewritten onto the model's own URI so
          // they're clickable inside the diff pane (no-op in the edit pane).
          return rewriteToModelUri(
            locs,
            model,
            uriToFilePath(decodeURIComponentSafe(modelToLspUri(model))),
          );
        } catch (err) {
          lspGotoTracker.end(
            activity,
            "error",
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }
      },
    }),
  );

  // textDocument/implementation -- "Go to Implementation" (Ctrl+F12 in VS Code).
  // On an interface method this jumps to the concrete class(es) that implement
  // it. Cross-file results are opened via the store like definition.
  providerDisposers.push(
    monaco.languages.registerImplementationProvider(languageId, {
      provideImplementation: async (model, position) => {
        const docUri = modelToLspUri(model);
        const activity = lspGotoTracker.begin("implementation");
        try {
          const result = await lspRequest("textDocument/implementation", {
            textDocument: { uri: docUri },
            position: toLspPosition(position),
          });
          const locs = toMonacoLocations(result, monaco);
          if (!locs || locs.length === 0) {
            lspGotoTracker.end(activity, "empty");
            return null;
          }
          // Cross-file navigation: open the first target via the store.
          const currentPath = uriToFilePath(decodeURIComponentSafe(docUri));
          const firstRaw = firstRawLocation(result);
          if (firstRaw) {
            const targetPath = uriToFilePath(decodeURIComponentSafe(firstRaw.uri));
            if (targetPath !== currentPath) {
              gotoLocation(
                targetPath,
                firstRaw.range.start.line + 1,
                firstRaw.range.start.character + 1,
              );
              lspGotoTracker.end(activity, "done");
              return null;
            }
          }
          // Same-file: return locations so Monaco navigates natively (rewritten
          // onto the model's own URI — see the definition provider). Record
          // the pre-jump position for Alt+← (navigation history), same as the
          // definition provider above.
          useSessionStore.getState().pushNavHistory({
            filePath: currentPath,
            line: position.lineNumber,
            column: position.column,
          });
          lspGotoTracker.end(activity, "done");
          return rewriteToModelUri(locs, model, currentPath);
        } catch (err) {
          lspGotoTracker.end(
            activity,
            "error",
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }
      },
    }),
  );

  // textDocument/hover
  providerDisposers.push(
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: async (model, position) => {
        // Silent on failure: hover fires on every mouse move, so errors
        // (server disabled, no workspace) must not spam anywhere.
        try {
          const result = await lspRequest("textDocument/hover", {
            textDocument: { uri: modelToLspUri(model) },
            position: toLspPosition(position),
          });
          return toMonacoHover(result, monaco);
        } catch {
          return null;
        }
      },
    }),
  );
}

/* ──────────────────────── goto activity tracking ────────────────────────
 *
 * Interactive LSP navigation (F12 / Ctrl+F12 / Shift+F12) can take seconds
 * on a cold server (spawn + initialize handshake + tsserver project load),
 * and the cross-file path returns null to Monaco — the editor shows NOTHING
 * while the request is in flight, and nothing when it comes back empty.
 * This tiny pub/sub (same pattern as OpenTabsBar's ideDirtyTracker) lets
 * EditPane render a small floating "正在查找…" pill so the user can see the
 * query is working, and briefly see the outcome ("未找到实现" / the error,
 * e.g. "语言服务器未启用"). Hover is deliberately NOT tracked (too chatty). */

export type GotoKind = "definition" | "implementation" | "references";

export interface GotoActivity {
  id: number;
  kind: GotoKind;
  startedAt: number;
  state: "pending" | "done" | "empty" | "error";
  /** Terminal-state detail (error message, shown as the pill's tooltip). */
  message?: string;
}

const gotoActivities = new Map<number, GotoActivity>();
const gotoListeners = new Set<() => void>();
/** Stable snapshot for useSyncExternalStore (rebuilt only on changes, so the
 *  Object.is identity rule holds between notifications). */
let gotoSnapshot: GotoActivity[] = [];
let gotoSeq = 0;
/** How long a terminal (done/empty/error) entry lingers in the snapshot so
 *  the pill can show its outcome before being dropped. */
const GOTO_RESULT_LINGER_MS = 1800;

function notifyGoto(): void {
  gotoSnapshot = [...gotoActivities.values()];
  gotoListeners.forEach((fn) => fn());
}

export const lspGotoTracker = {
  begin(kind: GotoKind): number {
    const id = ++gotoSeq;
    gotoActivities.set(id, { id, kind, startedAt: Date.now(), state: "pending" });
    notifyGoto();
    return id;
  },
  end(id: number, state: "done" | "empty" | "error", message?: string): void {
    const entry = gotoActivities.get(id);
    if (!entry) return;
    entry.state = state;
    entry.message = message;
    notifyGoto();
    // Drop the terminal entry after the linger so the pill fades out.
    setTimeout(() => {
      if (gotoActivities.get(id) === entry) {
        gotoActivities.delete(id);
        notifyGoto();
      }
    }, GOTO_RESULT_LINGER_MS);
  },
  subscribe(fn: () => void): () => void {
    gotoListeners.add(fn);
    return () => gotoListeners.delete(fn);
  },
};

/** Hook: current goto activities (in-flight + briefly-lingering results).
 *  Re-renders the caller whenever the set changes. */
export function useLspGotoActivities(): GotoActivity[] {
  return useSyncExternalStore(
    lspGotoTracker.subscribe,
    () => gotoSnapshot,
    () => gotoSnapshot,
  );
}

/* ──────────────────────── coordinate / type conversion ──────────────────────── */

function toLspPosition(p: { lineNumber: number; column: number }): {
  line: number;
  character: number;
} {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

/** LSP Location[] -> Monaco Location[] (for both definition + references). */
function toMonacoLocations(
  result: unknown,
  monaco: typeof import("monaco-editor"),
): languages.Location[] | null {
  if (!result) return null;
  if (isLocation(result)) {
    return [locationToMonaco(result, monaco)];
  }
  if (Array.isArray(result)) {
    const locs = result.filter(isLocation).map((l) => locationToMonaco(l, monaco));
    return locs.length > 0 ? locs : null;
  }
  return null;
}

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function isLocation(v: unknown): v is LspLocation {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as LspLocation).uri === "string" &&
    !!(v as LspLocation).range
  );
}

/** Extract the first LspLocation from a raw LSP definition/references result.
 *  Works with both a single Location and a Location[]. Returns null if the
 *  result doesn't contain a usable location. */
function firstRawLocation(result: unknown): LspLocation | null {
  if (isLocation(result)) return result;
  if (Array.isArray(result)) {
    return result.find(isLocation) ?? null;
  }
  return null;
}

/** Rewrite Locations that resolve to the CURRENT model's own file onto the
 *  MODEL's URI. Monaco's standalone navigation (revealDefinition, peek
 *  references) only follows a Location whose URI exactly equals the source
 *  editor's model URI (`findModel` does a strict string compare and returns
 *  null otherwise). In the edit pane the model URI already equals the file
 *  URI, so this is a no-op there; in the diff pane the models are anonymous
 *  (inmemory://), and without the rewrite same-file jumps would silently do
 *  nothing. Locations in OTHER files keep their file URI (the peek widget
 *  lists them; clicking cross-file is handled by the cross-file branch for
 *  definition/implementation). */
function rewriteToModelUri(
  locs: languages.Location[],
  model: { uri: Uri },
  currentPath: string,
): languages.Location[] {
  return locs.map((l) =>
    uriToFilePath(decodeURIComponentSafe(l.uri.toString())) === currentPath
      ? { uri: model.uri as Uri, range: l.range }
      : l,
  );
}

/** decodeURIComponent that returns the input unchanged on failure (some LSP
 *  servers send URIs with characters that throw). */
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function locationToMonaco(
  loc: LspLocation,
  monaco: typeof import("monaco-editor"),
): languages.Location {
  return {
    uri: monaco.Uri.parse(loc.uri) as Uri,
    range: lspRangeToMonaco(loc.range, monaco),
  };
}

function lspRangeToMonaco(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  monaco: typeof import("monaco-editor"),
): IRange {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

interface LspHover {
  contents:
    | string
    | { language?: string; value: string }
    | Array<string | { language?: string; value: string }>;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function toMonacoHover(
  result: unknown,
  monaco: typeof import("monaco-editor"),
): languages.Hover | null {
  if (!result) return null;
  const hover = result as LspHover;
  // Monaco wants IMarkdownString[] for `contents`.
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const mdContents = contents.map((c) => {
    if (typeof c === "string") return { value: c };
    if (c && typeof c === "object" && "value" in c) {
      return c.language
        ? { value: "```" + c.language + "\n" + c.value + "\n```" }
        : { value: c.value };
    }
    return { value: String(c) };
  });
  return {
    contents: mdContents,
    range: hover.range ? lspRangeToMonaco(hover.range, monaco) : undefined,
  };
}

/* ──────────────────────── diagnostics subscription hook ──────────────────────── */

/** Severity mapping LSP (1=Error..4=Hint) -> Monaco MarkerSeverity. */
function lspSeverityToMonaco(sev: number, monaco: typeof import("monaco-editor")): MarkerSeverity {
  switch (sev) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

/** React hook: subscribe to `lsp:event` diagnostics for `filePath`'s model and
 *  apply them as Monaco markers. Clears markers on unmount. Returns nothing;
 *  the side effect is on the model.
 *
 *  The model is created with `path={filePathToUri(filePath)}` (a `file://`
 *  URI), so `Uri.parse(filePathToUri(filePath))` finds it, and the server's
 *  diagnostics `uri` (also a `file://` URI) matches directly. */
export function useLspDiagnostics(
  filePath: string,
  getMonaco: () => typeof import("monaco-editor") | null,
  getEditor: () => editor.IStandaloneCodeEditor | null,
): void {
  const versionRef = useRef(0);
  useEffect(() => {
    const monaco = getMonaco();
    if (!monaco) return;
    const lspUri = filePathToUri(filePath);
    const modelUri = monaco.Uri.parse(lspUri);
    const unsub = api.on.lspEvent((msg) => {
      if (msg.type !== "diagnostics") return;
      const payload = msg.payload as { uri: string; diagnostics: LspDiagnostic[] };
      if (payload.uri !== lspUri) return;
      const model = monaco.editor.getModel(modelUri);
      if (!model) return;
      const markers = payload.diagnostics.map((d) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        message: d.message,
        severity: lspSeverityToMonaco(d.severity, monaco),
        source: d.source,
      }));
      monaco.editor.setModelMarkers(model, "lsp", markers);
      versionRef.current++;
    });
    return () => {
      unsub();
      // Clear markers when the file closes.
      const m = monaco.editor.getModel(modelUri);
      if (m) monaco.editor.setModelMarkers(m, "lsp", []);
    };
  }, [filePath, getMonaco, getEditor]);
}

/* ──────────────────────── uri helper (mirrors LspManager) ──────────────────────── */

/** Convert an absolute file path to a `file://` URI. Must match the main
 *  process's `filePathToUri` so diagnostics URIs line up with model URIs.
 *  Exported so FileEditor can use it as the Monaco model `path` prop -- this
 *  ensures `model.uri.toString()` yields the same `file://` URI the server
 *  uses, avoiding a URI-mismatch bug where Monaco would otherwise parse a bare
 *  Windows path as a `d:`-scheme URI. */
export function filePathToUri(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const prefixed = /^[a-zA-Z]:/.test(norm) ? `/${norm}` : norm;
  return `file://${prefixed}`;
}

/** Inverse of filePathToUri: `file:///c:/foo.ts` -> `C:\foo\bar.ts` (Windows,
 *  with native backslashes + UPPERCASE drive letter) or `/home/foo.ts` (POSIX).
 *  Used to turn a cross-file definition Location's URI back into a filesystem
 *  path for openFileInIde -- the path must match the OS-native form stored in
 *  the session store (file tree uses backslashes + uppercase drive on Windows).
 *  The drive letter is uppercased because Monaco/LSP may lowercase it, but the
 *  file tree + store preserve the user's original casing. */
function uriToFilePath(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  // Windows: leading `/c:/` -> `c:/`, then uppercase the drive letter.
  p = p.replace(/^\/([a-zA-Z]):/, (_, letter) => letter.toUpperCase() + ":");
  // Windows: convert forward slashes to backslashes to match the OS-native
  // paths the file tree + session store use. Detect Windows by drive letter.
  if (/^[a-zA-Z]:/.test(p)) {
    p = p.replace(/\//g, "\\");
  }
  return p;
}

/** Convert a Monaco model's URI to the canonical `file://` URI the LSP server
 *  expects. Anonymous models bound via `bindModelToPath` (DiffPane's two
 *  sides) resolve through the binding table. FileEditor creates models with
 *  `path={filePathToUri(filePath)}` (a `file://` URI), so `model.uri.toString()`
 *  already yields the canonical form. The fsPath fallback exists for safety in
 *  case a model was created with a bare path (e.g. legacy code or test
 *  harnesses). */
function modelToLspUri(model: { uri: Uri }): string {
  const bound = modelPathBindings.get(model.uri.toString());
  if (bound) return filePathToUri(bound);
  const uriStr = model.uri.toString();
  if (uriStr.startsWith("file:")) return uriStr;
  // Fallback: bare path model -- re-encode via fsPath.
  const fsPath = (model.uri as unknown as { fsPath?: string }).fsPath;
  if (fsPath) return filePathToUri(fsPath);
  return uriStr;
}

/* ──────────────────────── document sync helpers ──────────────────────── */

/** Open a document in the LSP server (didOpen). Called from EditPane onMount.
 *  Resolves silently on failure (server not enabled / not installed) so the
 *  editor still works without LSP. */
export async function openLspDocument(
  workspacePath: string,
  filePath: string,
  languageId: string,
): Promise<void> {
  const lspLang = monacoLanguageToLsp(languageId);
  if (!lspLang) return;
  try {
    await api.lsp.openDocument({ workspacePath, filePath, language: lspLang });
  } catch (err) {
    console.debug("lsp.openDocument failed:", err);
  }
}

/** Notify the server of a content change (didChange). Debounce in the caller. */
export async function notifyLspChange(
  workspacePath: string,
  filePath: string,
  languageId: string,
  text: string,
  version: number,
): Promise<void> {
  const lspLang = monacoLanguageToLsp(languageId);
  if (!lspLang) return;
  try {
    await api.lsp.didChange({ workspacePath, filePath, text, version });
  } catch (err) {
    console.debug("lsp.didChange failed:", err);
  }
}

/** Notify the server of a save (didSave). */
export async function notifyLspSave(
  workspacePath: string,
  filePath: string,
  languageId: string,
  text: string,
): Promise<void> {
  const lspLang = monacoLanguageToLsp(languageId);
  if (!lspLang) return;
  try {
    await api.lsp.didSave({ workspacePath, filePath, text });
  } catch (err) {
    console.debug("lsp.didSave failed:", err);
  }
}

/** Close a document (didClose). Called from EditPane unmount. */
export async function closeLspDocument(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  try {
    await api.lsp.closeDocument({ workspacePath, filePath });
  } catch (err) {
    console.debug("lsp.closeDocument failed:", err);
  }
}

/** Goto-definition navigation helper: open `filePath` at (line, column) in the
 *  IDE editor via the store, which triggers the EditPane reveal effect.
 *  Callers pass 1-based line/column (LSP 0-based + 1) -- do NOT add offsets
 *  here again. */
export function gotoLocation(
  filePath: string,
  line: number,
  character: number,
): void {
  useSessionStore.getState().openFileInIde(filePath, {
    line,
    column: character,
  });
}
