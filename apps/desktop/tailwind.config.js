/** @type {import('tailwindcss').Config} */
export default {
  // 'class' so we can toggle dark mode by adding/removing `.dark` on <html>,
  // driven by nativeTheme.themeSource (see main/lib/theme.ts).
  darkMode: "class",
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        // Bundled JetBrains Mono Variable woff2 (imported in main.tsx) heads
        // the monospace stack so every `font-mono` surface - code blocks,
        // terminals, file trees, diffs - renders a consistent modern face
        // across platforms, falling back to the OS monospace only if the
        // bundled font fails to load. The UI sans stack stays system-native
        // (defined in styles.css) for a native-feeling chrome.
        mono: [
          '"JetBrains Mono Variable"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          '"Liberation Mono"',
          '"Courier New"',
          "monospace",
        ],
      },
      colors: {
        // Semantic tokens backed by CSS variables. Each variable holds a
        // space-separated "R G B" triplet (NOT #hex) so Tailwind's
        // <alpha-value> placeholder can compose `bg-surface/50` etc.
        // Definitions live in styles.css (:root = light, .dark = dark).
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
        },
        content: {
          DEFAULT: "rgb(var(--content) / <alpha-value>)",
          muted: "rgb(var(--content-muted) / <alpha-value>)",
          subtle: "rgb(var(--content-subtle) / <alpha-value>)",
        },
        edge: {
          DEFAULT: "rgb(var(--edge) / <alpha-value>)",
          input: "rgb(var(--input-edge) / <alpha-value>)",
        },
        accent: "rgb(var(--accent) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        // Fixed semantic green (git additions etc.) — same value as the
        // DEFAULT accent but never overridden at runtime, so diff stats keep
        // their green when the user customizes the brand color.
        success: "rgb(var(--success) / <alpha-value>)",
        // User message bubble background — user-configurable color (default
        // = info token). Stored as an "R G B" triplet so the same
        // <alpha-value> mechanism composes bg-userBubble/10 etc. The value
        // is overridden at runtime via setProperty on <html> when the user
        // picks a custom color in Settings (see lib/appearance.ts).
        userBubble: "rgb(var(--user-bubble) / <alpha-value>)",

        // Legacy pane tokens — kept as aliases to the new semantic variables
        // so partially-migrated files still follow the theme. New code should
        // use surface/edge directly.
        pane: {
          left: "rgb(var(--surface) / <alpha-value>)",
          center: "rgb(var(--surface-muted) / <alpha-value>)",
          right: "rgb(var(--surface) / <alpha-value>)",
          border: "rgb(var(--edge) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
