import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { initFoucGuard } from "./lib/theme.js";
import { isElectron, isMobileDevice } from "./lib/platform.js";
import "./styles.css";
// KaTeX typography (fonts + layout) for math rendered by rehype-katex in
// Markdown.tsx. Without this, KaTeX emits correct HTML but no styling, so
// fractions/roots/superscripts collapse to unstyled text. Vite resolves the
// `url(fonts/*.woff2)` references inside this CSS automatically.
import "katex/dist/katex.min.css";
// JetBrains Mono Variable - bundled monospace face (woff2 with unicode-range
// subsetting + font-display:swap). Used as the default for all `font-mono`
// surfaces (code blocks, terminals, file trees, diffs) so they render with a
// modern, consistent face across platforms instead of falling back to the OS
// default (SF Mono / Consolas / Menlo). Bundling one variable woff2 per subset
// keeps the cost small (~200KB total). See tailwind.config.js + TerminalView.
import "@fontsource-variable/jetbrains-mono";

// Shell selection: Electron gets the desktop three-pane shell; a plain
// browser (the phone served over LAN) gets the mobile shell. Both are lazy so
// each environment only pulls the chunk it renders — the desktop never loads
// the mobile shell (and vice versa), and the phone never loads the Electron
// panels (terminal / browser view / Monaco editor) that App statically pulls.
const App = lazy(() => import("./App.js").then((m) => ({ default: m.App })));
const AppMobile = lazy(() => import("./AppMobile.js").then((m) => ({ default: m.AppMobile })));

// Apply the initial theme class BEFORE React mounts so the first painted
// frame matches the OS theme (FOUC guard). Must run synchronously here, ahead
// of createRoot, and lives in this external module so it passes prod CSP.
initFoucGuard();

// Mobile focus-zoom guard marker: on real phones/tablets stamp the shell so
// styles.css can force ≥16px on every focusable control. iOS Safari zooms the
// page to ~2x when an input/contenteditable with font-size < 16px gains focus,
// which shoves part of the field off-screen — the font bump is the accessible
// fix (maximum-scale=1 would break WCAG 1.4.4 and iOS ignores it anyway).
if (isMobileDevice) document.documentElement.dataset.shell = "mobile";

const Root = isElectron ? App : AppMobile;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
