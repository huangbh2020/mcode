/**
 * Editor color-scheme presets for the Monaco file editor / plan viewer.
 *
 * Pure data module (the only monaco import is a TYPE-only one, erased at
 * runtime) so both the store and the settings panel can consume the preset
 * list / defaults without pulling the monaco bundle into scope.
 * `lib/monacoSetup.ts` registers every `data` with `monaco.editor.defineTheme`
 * at module load; `FileEditor`'s `useMonacoTheme()` picks the id based on the
 * app's effective light/dark mode and the user's persisted choice
 * (`settings` key `ui.editorTheme`, one id per mode).
 *
 * The two "Mcode" presets keep the original design goal — the editor chrome
 * (background, gutters, widgets, scrollbars, diff tints) mirrors the app's
 * styles.css tokens so it melts into the surrounding panes, while syntax
 * tokens inherit the stock vs-dark / vs palette. The rest are faithful
 * approximations of well-known editor themes; their chrome follows their own
 * palette (an One Dark editor on a slate app background is the point).
 */

import type { editor } from "monaco-editor";
import type { MessageId } from "@renderer/lib/i18n/index.js";

/** One row of the scheme picker: a theme's id, which app mode it belongs to,
 *  its translated display name, the swatch dots shown next to the name, and
 *  the theme payload handed to `monaco.editor.defineTheme`. */
export interface EditorThemePreset {
  id: EditorThemeId;
  /** Which app theme (light/dark) this scheme is offered under. */
  mode: "dark" | "light";
  labelKey: MessageId;
  /** Representative colors for the picker's preview dots: background of the
   *  editor plus the four highest-frequency token classes. */
  swatch: {
    background: string;
    keyword: string;
    string: string;
    number: string;
    comment: string;
  };
  data: editor.IStandaloneThemeData;
}

export const EDITOR_THEME_IDS = [
  "mcode-dark",
  "mcode-one-dark",
  "mcode-monokai",
  "mcode-solarized-dark",
  "mcode-light",
  "mcode-solarized-light",
  "mcode-github-light",
] as const;
export type EditorThemeId = (typeof EDITOR_THEME_IDS)[number];

export function isKnownEditorThemeId(id: string): id is EditorThemeId {
  return (EDITOR_THEME_IDS as readonly string[]).includes(id);
}

/** The user's per-mode scheme choice (one for each app theme). */
export interface EditorThemeChoice {
  dark: EditorThemeId;
  light: EditorThemeId;
}

/** Defaults: the "Mcode" pair — chrome mirroring styles.css tokens with the
 *  stock vs-dark / vs token palettes (i.e. the pre-setting appearance). */
export const DEFAULT_EDITOR_THEME_CHOICE: EditorThemeChoice = {
  dark: "mcode-dark",
  light: "mcode-light",
};

/** Parse the persisted `ui.editorTheme` value. Any malformed JSON or unknown
 *  id falls back field-by-field to the default — a hand-edited DB row must
 *  never leave Monaco selecting an unregistered theme (it would throw). */
export function parseEditorThemeChoice(raw: string | null | undefined): EditorThemeChoice {
  if (!raw) return DEFAULT_EDITOR_THEME_CHOICE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_EDITOR_THEME_CHOICE;
    const obj = parsed as Record<string, unknown>;
    const dark = typeof obj.dark === "string" && isKnownEditorThemeId(obj.dark)
      ? obj.dark
      : DEFAULT_EDITOR_THEME_CHOICE.dark;
    const light = typeof obj.light === "string" && isKnownEditorThemeId(obj.light)
      ? obj.light
      : DEFAULT_EDITOR_THEME_CHOICE.light;
    return { dark, light };
  } catch {
    return DEFAULT_EDITOR_THEME_CHOICE;
  }
}

export const EDITOR_THEME_PRESETS: EditorThemePreset[] = [
  {
    id: "mcode-dark",
    mode: "dark",
    labelKey: "settings.appearance.schemeMcodeDark",
    swatch: {
      background: "#1a1d24",
      keyword: "#569cd6",
      string: "#ce9178",
      number: "#b5cea8",
      comment: "#6a9955",
    },
    data: {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        // Chrome mirrors styles.css .dark tokens (slate ramp). Keep in sync.
        "editor.background": "#1a1d24", // --surface
        "editor.foreground": "#e7e8ec", // --content
        "editorLineNumber.foreground": "#9ea2ab", // --content-subtle
        "editorLineNumber.activeForeground": "#bcbfc6", // --content-muted
        "editorCursor.foreground": "#e7e8ec",
        "editor.selectionBackground": "#264f78aa",
        "editor.inactiveSelectionBackground": "#264f7840",
        "editor.lineHighlightBackground": "#3a404e22",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#3a404e40",
        "editorIndentGuide.activeBackground1": "#9ea2ab80",
        "editorBracketMatch.background": "#10b9812a", // --accent tint
        "editorBracketMatch.border": "#10b98188",
        "editorGutter.background": "#1a1d24",
        "editorWidget.background": "#2c313c", // --surface-muted
        "editorWidget.border": "#2d3340", // --edge
        "editorSuggestWidget.background": "#2c313c",
        "editorSuggestWidget.border": "#2d3340",
        "editorSuggestWidget.selectedBackground": "#3a404e", // --surface-hover
        "editorHoverWidget.background": "#2c313c",
        "editorHoverWidget.border": "#2d3340",
        "editorError.foreground": "#f87171",
        "editorWarning.foreground": "#fbbf24",
        "editorInfo.foreground": "#a78bfa",
        "scrollbarSlider.background": "#3a404e66",
        "scrollbarSlider.hoverBackground": "#3a404e",
        "scrollbarSlider.activeBackground": "#4a5162",
        "minimap.background": "#1a1d24",
        "minimapSlider.background": "#3a404e77",
        "diffEditor.insertedTextBackground": "#10b98122",
        "diffEditor.removedTextBackground": "#f8717122",
        "diffEditor.insertedLineBackground": "#10b98114",
        "diffEditor.removedLineBackground": "#f8717114",
      },
    },
  },
  {
    id: "mcode-one-dark",
    mode: "dark",
    labelKey: "settings.appearance.schemeOneDark",
    swatch: {
      background: "#282c34",
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      comment: "#5c6370",
    },
    data: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "5c6370", fontStyle: "italic" },
        { token: "keyword", foreground: "c678dd" },
        { token: "keyword.operator", foreground: "56b6c2" },
        { token: "string", foreground: "98c379" },
        { token: "number", foreground: "d19a66" },
        { token: "constant", foreground: "d19a66" },
        { token: "type.identifier", foreground: "e5c07b" },
        { token: "entity.name.type", foreground: "e5c07b" },
        { token: "entity.name.function", foreground: "61afef" },
        { token: "support.function", foreground: "61afef" },
        { token: "tag", foreground: "e06c75" },
        { token: "attribute.name", foreground: "d19a66" },
        { token: "metatag", foreground: "c678dd" },
      ],
      colors: {
        "editor.background": "#282c34",
        "editor.foreground": "#abb2bf",
        "editorLineNumber.foreground": "#5c6370",
        "editorLineNumber.activeForeground": "#abb2bf",
        "editorCursor.foreground": "#528bff",
        "editor.selectionBackground": "#3e4451",
        "editor.inactiveSelectionBackground": "#3e445170",
        "editor.lineHighlightBackground": "#2c313c",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#3e445180",
        "editorIndentGuide.activeBackground1": "#5c6370cc",
        "editorBracketMatch.background": "#61afef33",
        "editorBracketMatch.border": "#61afef88",
        "editorGutter.background": "#282c34",
        "editorWidget.background": "#21252b",
        "editorWidget.border": "#181a1f",
        "editorSuggestWidget.background": "#21252b",
        "editorSuggestWidget.border": "#181a1f",
        "editorSuggestWidget.selectedBackground": "#2c313c",
        "editorHoverWidget.background": "#21252b",
        "editorHoverWidget.border": "#181a1f",
        "editorError.foreground": "#e06c75",
        "editorWarning.foreground": "#e5c07b",
        "editorInfo.foreground": "#61afef",
        "scrollbarSlider.background": "#3e445199",
        "scrollbarSlider.hoverBackground": "#3e4451",
        "scrollbarSlider.activeBackground": "#545b6e",
        "minimap.background": "#21252b",
        "minimapSlider.background": "#3e445177",
        "diffEditor.insertedTextBackground": "#98c37922",
        "diffEditor.removedTextBackground": "#e06c7522",
        "diffEditor.insertedLineBackground": "#98c37914",
        "diffEditor.removedLineBackground": "#e06c7514",
      },
    },
  },
  {
    id: "mcode-monokai",
    mode: "dark",
    labelKey: "settings.appearance.schemeMonokai",
    swatch: {
      background: "#272822",
      keyword: "#f92672",
      string: "#e6db74",
      number: "#ae81ff",
      comment: "#75715e",
    },
    data: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "75715e", fontStyle: "italic" },
        { token: "keyword", foreground: "f92672" },
        { token: "keyword.operator", foreground: "f92672" },
        { token: "string", foreground: "e6db74" },
        { token: "string.escape", foreground: "ae81ff" },
        { token: "number", foreground: "ae81ff" },
        { token: "constant", foreground: "ae81ff" },
        { token: "type.identifier", foreground: "66d9ef", fontStyle: "italic" },
        { token: "entity.name.type", foreground: "66d9ef", fontStyle: "italic" },
        { token: "entity.name.function", foreground: "a6e22e" },
        { token: "support.function", foreground: "66d9ef" },
        { token: "variable.parameter", foreground: "fd971f", fontStyle: "italic" },
        { token: "tag", foreground: "f92672" },
        { token: "attribute.name", foreground: "a6e22e" },
        { token: "metatag", foreground: "75715e" },
      ],
      colors: {
        "editor.background": "#272822",
        "editor.foreground": "#f8f8f2",
        "editorLineNumber.foreground": "#90908a",
        "editorLineNumber.activeForeground": "#f8f8f2",
        "editorCursor.foreground": "#f8f8f0",
        "editor.selectionBackground": "#49483e",
        "editor.inactiveSelectionBackground": "#49483e80",
        "editor.lineHighlightBackground": "#3e3d32",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#49483e",
        "editorIndentGuide.activeBackground1": "#75715e",
        "editorBracketMatch.background": "#49483e",
        "editorBracketMatch.border": "#a6e22e88",
        "editorGutter.background": "#272822",
        "editorWidget.background": "#3e3d32",
        "editorWidget.border": "#1e1f1c",
        "editorSuggestWidget.background": "#3e3d32",
        "editorSuggestWidget.border": "#1e1f1c",
        "editorSuggestWidget.selectedBackground": "#49483e",
        "editorHoverWidget.background": "#3e3d32",
        "editorHoverWidget.border": "#1e1f1c",
        "editorError.foreground": "#f92672",
        "editorWarning.foreground": "#e6db74",
        "editorInfo.foreground": "#66d9ef",
        "scrollbarSlider.background": "#49483e99",
        "scrollbarSlider.hoverBackground": "#49483e",
        "scrollbarSlider.activeBackground": "#75715e",
        "minimap.background": "#272822",
        "minimapSlider.background": "#49483e77",
        "diffEditor.insertedTextBackground": "#a6e22e22",
        "diffEditor.removedTextBackground": "#f9267222",
        "diffEditor.insertedLineBackground": "#a6e22e14",
        "diffEditor.removedLineBackground": "#f9267214",
      },
    },
  },
  {
    id: "mcode-solarized-dark",
    mode: "dark",
    labelKey: "settings.appearance.schemeSolarizedDark",
    swatch: {
      background: "#002b36",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      comment: "#586e75",
    },
    data: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "586e75", fontStyle: "italic" },
        { token: "keyword", foreground: "859900" },
        { token: "keyword.operator", foreground: "859900" },
        { token: "string", foreground: "2aa198" },
        { token: "number", foreground: "d33682" },
        { token: "constant", foreground: "cb4b16" },
        { token: "type.identifier", foreground: "b58900" },
        { token: "entity.name.type", foreground: "b58900" },
        { token: "entity.name.function", foreground: "268bd2" },
        { token: "support.function", foreground: "268bd2" },
        { token: "variable.parameter", foreground: "268bd2", fontStyle: "italic" },
        { token: "tag", foreground: "268bd2" },
        { token: "attribute.name", foreground: "93a1a1" },
        { token: "metatag", foreground: "586e75" },
      ],
      colors: {
        "editor.background": "#002b36",
        "editor.foreground": "#839496",
        "editorLineNumber.foreground": "#586e75",
        "editorLineNumber.activeForeground": "#93a1a1",
        "editorCursor.foreground": "#839496",
        "editor.selectionBackground": "#073642",
        "editor.inactiveSelectionBackground": "#07364280",
        "editor.lineHighlightBackground": "#073642",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#586e7540",
        "editorIndentGuide.activeBackground1": "#93a1a1aa",
        "editorBracketMatch.background": "#073642",
        "editorBracketMatch.border": "#93a1a1aa",
        "editorGutter.background": "#002b36",
        "editorWidget.background": "#073642",
        "editorWidget.border": "#586e75",
        "editorSuggestWidget.background": "#073642",
        "editorSuggestWidget.border": "#586e75",
        "editorSuggestWidget.selectedBackground": "#0a4652",
        "editorHoverWidget.background": "#073642",
        "editorHoverWidget.border": "#586e75",
        "editorError.foreground": "#dc322f",
        "editorWarning.foreground": "#b58900",
        "editorInfo.foreground": "#268bd2",
        "scrollbarSlider.background": "#586e7566",
        "scrollbarSlider.hoverBackground": "#586e75aa",
        "scrollbarSlider.activeBackground": "#93a1a1",
        "minimap.background": "#002b36",
        "minimapSlider.background": "#586e7577",
        "diffEditor.insertedTextBackground": "#85990022",
        "diffEditor.removedTextBackground": "#dc322f22",
        "diffEditor.insertedLineBackground": "#85990014",
        "diffEditor.removedLineBackground": "#dc322f14",
      },
    },
  },
  {
    id: "mcode-light",
    mode: "light",
    labelKey: "settings.appearance.schemeMcodeLight",
    swatch: {
      background: "#ffffff",
      keyword: "#0000ff",
      string: "#a31515",
      number: "#098658",
      comment: "#008000",
    },
    data: {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        // Chrome mirrors styles.css :root tokens; tokens inherit stock vs.
        "editor.background": "#ffffff", // --surface
        "editor.foreground": "#09090b", // --content
        "editorLineNumber.foreground": "#71717a", // --content-subtle
        "editorLineNumber.activeForeground": "#3f3f46", // --content-muted
        "editorCursor.foreground": "#09090b",
        "editor.selectionBackground": "#add6ff",
        "editor.inactiveSelectionBackground": "#add6ff80",
        "editor.lineHighlightBackground": "#e4e4e733",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#e4e4e7",
        "editorIndentGuide.activeBackground1": "#a1a1aa99",
        "editorBracketMatch.background": "#0596691f", // --accent tint
        "editorBracketMatch.border": "#05966966",
        "editorGutter.background": "#ffffff",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#e4e4e7", // --edge
        "editorSuggestWidget.background": "#ffffff",
        "editorSuggestWidget.border": "#e4e4e7",
        "editorSuggestWidget.selectedBackground": "#e4e4e7", // --surface-hover
        "editorHoverWidget.background": "#ffffff",
        "editorHoverWidget.border": "#e4e4e7",
        "editorError.foreground": "#dc2626",
        "editorWarning.foreground": "#d97706",
        "editorInfo.foreground": "#7c3aed",
        "scrollbarSlider.background": "#a1a1aa66",
        "scrollbarSlider.hoverBackground": "#a1a1aa",
        "scrollbarSlider.activeBackground": "#71717a",
        "minimap.background": "#ffffff",
        "minimapSlider.background": "#a1a1aa55",
        "diffEditor.insertedTextBackground": "#0596691f",
        "diffEditor.removedTextBackground": "#dc26261f",
        "diffEditor.insertedLineBackground": "#05966914",
        "diffEditor.removedLineBackground": "#dc262614",
      },
    },
  },
  {
    id: "mcode-solarized-light",
    mode: "light",
    labelKey: "settings.appearance.schemeSolarizedLight",
    swatch: {
      background: "#fdf6e3",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      comment: "#93a1a1",
    },
    data: {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "93a1a1", fontStyle: "italic" },
        { token: "keyword", foreground: "859900" },
        { token: "keyword.operator", foreground: "859900" },
        { token: "string", foreground: "2aa198" },
        { token: "number", foreground: "d33682" },
        { token: "constant", foreground: "cb4b16" },
        { token: "type.identifier", foreground: "b58900" },
        { token: "entity.name.type", foreground: "b58900" },
        { token: "entity.name.function", foreground: "268bd2" },
        { token: "support.function", foreground: "268bd2" },
        { token: "variable.parameter", foreground: "268bd2", fontStyle: "italic" },
        { token: "tag", foreground: "268bd2" },
        { token: "attribute.name", foreground: "93a1a1" },
        { token: "metatag", foreground: "93a1a1" },
      ],
      colors: {
        "editor.background": "#fdf6e3",
        "editor.foreground": "#657b83",
        "editorLineNumber.foreground": "#93a1a1",
        "editorLineNumber.activeForeground": "#586e75",
        "editorCursor.foreground": "#586e75",
        "editor.selectionBackground": "#eee8d5",
        "editor.inactiveSelectionBackground": "#eee8d580",
        "editor.lineHighlightBackground": "#eee8d5",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#eee8d5",
        "editorIndentGuide.activeBackground1": "#93a1a1",
        "editorBracketMatch.background": "#eee8d5",
        "editorBracketMatch.border": "#93a1a1",
        "editorGutter.background": "#fdf6e3",
        "editorWidget.background": "#eee8d5",
        "editorWidget.border": "#93a1a1",
        "editorSuggestWidget.background": "#eee8d5",
        "editorSuggestWidget.border": "#93a1a1",
        "editorSuggestWidget.selectedBackground": "#e0dbca",
        "editorHoverWidget.background": "#eee8d5",
        "editorHoverWidget.border": "#93a1a1",
        "editorError.foreground": "#dc322f",
        "editorWarning.foreground": "#b58900",
        "editorInfo.foreground": "#268bd2",
        "scrollbarSlider.background": "#93a1a166",
        "scrollbarSlider.hoverBackground": "#93a1a1aa",
        "scrollbarSlider.activeBackground": "#586e75",
        "minimap.background": "#fdf6e3",
        "minimapSlider.background": "#93a1a177",
        "diffEditor.insertedTextBackground": "#85990022",
        "diffEditor.removedTextBackground": "#dc322f22",
        "diffEditor.insertedLineBackground": "#85990014",
        "diffEditor.removedLineBackground": "#dc322f14",
      },
    },
  },
  {
    id: "mcode-github-light",
    mode: "light",
    labelKey: "settings.appearance.schemeGithubLight",
    swatch: {
      background: "#ffffff",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#6e7781",
    },
    data: {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6e7781" },
        { token: "keyword", foreground: "cf222e" },
        { token: "keyword.operator", foreground: "0550ae" },
        { token: "string", foreground: "0a3069" },
        { token: "number", foreground: "0550ae" },
        { token: "constant", foreground: "0550ae" },
        { token: "type.identifier", foreground: "953800" },
        { token: "entity.name.type", foreground: "953800" },
        { token: "entity.name.function", foreground: "8250df" },
        { token: "support.function", foreground: "8250df" },
        { token: "tag", foreground: "116329" },
        { token: "attribute.name", foreground: "0550ae" },
        { token: "metatag", foreground: "6e7781" },
      ],
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#1f2328",
        "editorLineNumber.foreground": "#8c959f",
        "editorLineNumber.activeForeground": "#1f2328",
        "editorCursor.foreground": "#0969da",
        "editor.selectionBackground": "#b6e3ff",
        "editor.inactiveSelectionBackground": "#b6e3ff80",
        "editor.lineHighlightBackground": "#eaeef2",
        "editor.lineHighlightBorder": "#00000000",
        "editorIndentGuide.background1": "#eaeef2",
        "editorIndentGuide.activeBackground1": "#afb8c1",
        "editorBracketMatch.background": "#54aeff33",
        "editorBracketMatch.border": "#54aeff88",
        "editorGutter.background": "#ffffff",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#d1d9e0",
        "editorSuggestWidget.background": "#ffffff",
        "editorSuggestWidget.border": "#d1d9e0",
        "editorSuggestWidget.selectedBackground": "#eaeef2",
        "editorHoverWidget.background": "#ffffff",
        "editorHoverWidget.border": "#d1d9e0",
        "editorError.foreground": "#cf222e",
        "editorWarning.foreground": "#9a6700",
        "editorInfo.foreground": "#0969da",
        "scrollbarSlider.background": "#afb8c166",
        "scrollbarSlider.hoverBackground": "#afb8c1",
        "scrollbarSlider.activeBackground": "#8c959f",
        "minimap.background": "#ffffff",
        "minimapSlider.background": "#afb8c155",
        "diffEditor.insertedTextBackground": "#1a7f3726",
        "diffEditor.removedTextBackground": "#cf222e26",
        "diffEditor.insertedLineBackground": "#1a7f3714",
        "diffEditor.removedLineBackground": "#cf222e14",
      },
    },
  },
];

/** Presets offered for a given app mode, in picker order. */
export function editorThemePresetsForMode(mode: "dark" | "light"): EditorThemePreset[] {
  return EDITOR_THEME_PRESETS.filter((p) => p.mode === mode);
}
