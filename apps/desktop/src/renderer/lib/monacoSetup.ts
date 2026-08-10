/**
 * Monaco editor bootstrap — runs once at module load, before any <Editor>
 * component mounts.
 *
 * Two concerns handled here, both forced by our packaging constraints:
 *
 * 1. **No CDN.** `@monaco-editor/react`'s default loader fetches the monaco
 *    AMD bundle from jsdelivr. Our production CSP is `script-src 'self'`
 *    (main/index.ts), so that would be blocked. We instead hand the loader
 *    the locally-bundled ESM monaco instance via `loader.config({ monaco })`.
 *    Vite then bundles monaco-editor into the renderer chunk.
 *
 * 2. **Web workers.** Monaco offloads background work (tokenization, diffing,
 *    linkify) to Web Workers. In a bundler context the worker entry must be
 *    produced by the bundler, not fetched at runtime. Vite's `?worker` suffix
 *    instantiates a worker from a module. We map each language id to the
 *    matching worker entry via `self.MonacoEnvironment.getWorker`.
 *
 *    The worker import paths (`monaco-editor/esm/vs/...`) are the form
 *    `@monaco-editor/react`'s README documents for Vite. monaco-editor
 *    0.52+ ships a package.json `exports` field whose `./*.js` wildcard
 *    would mis-map these paths; the `resolve.alias` entries in
 *    electron.vite.config.ts neutralize that by pointing the paths straight
 *    at the on-disk files.
 *
 * Importing this module (anywhere) is enough to apply both settings — the
 * side effects run at import time. `FileEditor.tsx` imports it; nothing else
 * needs to.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Worker entries — Vite compiles each into a dedicated worker file.
// The `editorWorker` is mandatory (base services); the language workers are
// optional but enable richer highlighting/diagnostics per language.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Configure the worker factory BEFORE telling the loader about our instance.
// Monaco reads `self.MonacoEnvironment.getWorker` lazily, but setting it up
// first avoids a race on the first model creation.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Hand the loader our bundled instance so it never hits the CDN.
loader.config({ monaco });

/**
 * Custom dark theme ("mcode-dark") — the stock "vs-dark" paints Monaco on
 * #1e1e1e, which clashes with the app's neutral dark-gray surface (#18181b,
 * styles.css --surface) and makes the editor read as a foreign gray block.
 * This theme inherits vs-dark's token colors (`base: "vs-dark", inherit:
 * true`) and only re-paints the chrome: background, gutters, line numbers,
 * selection, widgets, scrollbars and diff gutters — all mirroring the app
 * tokens so the editor melts into the surrounding panes. Registered at module
 * load (side effect), before any Editor mounts; FileEditor/PlanViewer select
 * it via useMonacoTheme(). Keep the hex values in sync with styles.css. */
monaco.editor.defineTheme("mcode-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#18181b", // --surface
    "editor.foreground": "#e7e8ec", // --content
    "editorLineNumber.foreground": "#80848c", // --content-subtle
    "editorLineNumber.activeForeground": "#aab0b8", // --content-muted
    "editorCursor.foreground": "#e7e8ec",
    "editor.selectionBackground": "#264f78aa",
    "editor.inactiveSelectionBackground": "#264f7840",
    "editor.lineHighlightBackground": "#2c2d3322",
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background1": "#2c2d3340",
    "editorIndentGuide.activeBackground1": "#80848c80",
    "editorBracketMatch.background": "#10b9812a", // --accent tint
    "editorBracketMatch.border": "#10b98188",
    "editorGutter.background": "#18181b",
    "editorWidget.background": "#202126", // --surface-muted
    "editorWidget.border": "#292a2f", // --edge
    "editorSuggestWidget.background": "#202126",
    "editorSuggestWidget.border": "#292a2f",
    "editorSuggestWidget.selectedBackground": "#2c2d33", // --surface-hover
    "editorHoverWidget.background": "#202126",
    "editorHoverWidget.border": "#292a2f",
    "editorError.foreground": "#f87171",
    "editorWarning.foreground": "#fbbf24",
    "editorInfo.foreground": "#a78bfa",
    "scrollbarSlider.background": "#2c2d3366",
    "scrollbarSlider.hoverBackground": "#2c2d33",
    "scrollbarSlider.activeBackground": "#44454c",
    "minimap.background": "#18181b",
    "minimapSlider.background": "#2c2d3377",
    "diffEditor.insertedTextBackground": "#10b98122",
    "diffEditor.removedTextBackground": "#f8717122",
    "diffEditor.insertedLineBackground": "#10b98114",
    "diffEditor.removedLineBackground": "#f8717114",
  },
});

export { monaco };

/** Toggle Monaco's built-in TS/JS worker diagnostics. When an external TS
 *  language server is enabled, we suppress the worker's own diagnostics to
 *  avoid duplicate squiggles. Called from `reloadLspLanguages` after the LSP
 *  state is hydrated. Safe to call before any editor mounts (the defaults
 *  object is always available); idempotent. */
let tsDiagnosticsEnabled = true;
export function setTsWorkerDiagnosticsEnabled(enabled: boolean): void {
  tsDiagnosticsEnabled = enabled;
  try {
    // monaco-editor 0.52+ moved the TS language service defaults to the
    // top-level `typescript` namespace (the old `languages.typescript` is
    // marked deprecated).
    const ts = (monaco as unknown as {
      typescript?: {
        typescriptDefaults: { setDiagnosticsOptions(o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void };
        javascriptDefaults: { setDiagnosticsOptions(o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void };
      };
    }).typescript;
    if (!ts) return;
    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: !enabled,
      noSyntaxValidation: !enabled,
    });
    ts.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: !enabled,
      noSyntaxValidation: !enabled,
    });
  } catch {
    // monaco not fully initialized yet - the flag is still recorded so a
    // later editor mount picks it up via the defaults.
  }
}

/** Read the current TS-Worker diagnostics flag (used by EditPane to decide
 *  whether to expect duplicate markers). */
export function isTsWorkerDiagnosticsEnabled(): boolean {
  return tsDiagnosticsEnabled;
}
