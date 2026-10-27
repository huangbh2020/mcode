/**
 * Markdown rendering with syntax highlighting (Shiki + codeDiffs),
 * KaTeX math, and code-block output caching (FNV-1a + LRU).
 *
 * Performance layering:
 *  - react-markdown for the base markdown→React pipeline.
 *  - remark-math + rehype-katex for LaTeX math ($...$ / $$...$$).
 *  - Shiki for fenced-code-block highlighting (+ diff annotations via
 *    transformerNotationDiff).
 *  - code-html cache (fnv1a hash → shiki HTML) to avoid re-highlighting.
 *  - useDeferredValue is applied at the MessageBlocks layer, not here.
 *
 * Security: react-markdown escapes raw HTML by default, so we never need
 * DOMPurify. The only `dangerouslySetInnerHTML` usage is for shiki-generated
 * code-block HTML, which is produced from known content (the code text) and
 * is thus safe by construction.
 */
import { memo, useState, useEffect, useMemo, useRef, useLayoutEffect, createContext, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconChevronDown, IconChevronUp, IconCopy, IconLoader2 } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";
import { codeCacheKey, getCodeHtml, setCodeHtml } from "@renderer/lib/markdownCache.js";
import { fileHrefToPath, isAbsolutePath, isLocalFileHref, splitTextByPathTokens } from "@renderer/lib/fileLink.js";
import { FILE_PATH_LINK_CLASS, rehypePathInline } from "@renderer/lib/markdownPathLinks.js";
import { resolveRelativePath } from "@renderer/lib/path.js";
import { api } from "@renderer/lib/api.js";
import { FileLink } from "./FileLink.js";
import { ScheduledTaskApprovalCard } from "./ScheduledTaskApprovalCard.js";
import { MermaidBlock } from "./MermaidBlock.js";
import { ImageWithPreview } from "@renderer/components/ui/image-preview.js";

// ── Lazy highlighter singleton ────────────────────────────────────────
// Initialised on first encounter of a fenced code block; kept alive for the
// lifetime of the page. Dual-theme (light / dark) resolved via CSS class.
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { transformerNotationDiff } from "@shikijs/transformers";

type ShikiHighlighter = Highlighter;

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let highlighterInstance: ShikiHighlighter | null = null;

/** Languages we bundle eagerly (the ones Claude uses most). */
const EAGER_LANGS: BundledLanguage[] = [
  "typescript", "javascript", "jsx", "tsx",
  "python", "bash", "shell",
  "json", "markdown", "md", "yaml", "yml",
  "html", "css", "scss", "less", "sql", "xml", "diff",
  "vue", "svelte",
  "rust", "go", "java", "c", "cpp", "csharp",
  "ruby", "php", "swift", "kotlin",
  "docker", "dockerfile",
  "graphql", "gql",
  "ini", "toml", "makefile",
];

/**
 * Map common language aliases used in markdown fences to canonical Shiki
 * language ids. When a `resolveLang` falls back to "text" the code block
 * is rendered as plain monospace (no highlighting) instead of crashing.
 */
const LANG_ALIAS: Record<string, string> = {
  sh: "shell", zsh: "shell", fish: "shell",
  powershell: "shell", ps: "shell", cmd: "shell", dos: "shell", batch: "shell",
  mjs: "javascript", cjs: "javascript", es: "javascript", es6: "javascript",
  ts: "typescript",
  py: "python",
  mdx: "markdown",
  jsonc: "json", json5: "json",
  yml: "yaml",
  scss: "css", less: "css", sass: "css", stylus: "css",
  cc: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp",
  h: "c",
  containerfile: "dockerfile",
};

/** Module-level static remark/rehype plugin lists to avoid re-instantiating the unified pipeline on every render. */
const DEFAULT_REMARK_PLUGINS = [remarkGfm, remarkMath];
const DEFAULT_REHYPE_PLUGINS = [rehypeKatex];

/** Resolve a markdown code-fence language tag to a Shiki language id.
 *  Falls back to "text" when the language is unknown, effectively disabling
 *  highlighting for that block. */
function resolveLang(tag: string): string {
  if (!tag || tag === "text" || tag === "none" || tag === "plain") return "text";
  if (EAGER_LANGS.includes(tag as BundledLanguage)) return tag;
  return LANG_ALIAS[tag] ?? "text";
}

function ensureHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighter({
    // github-dark-default (#0d1117 bg) matches the app's deep dark surface
    // better than github-dark (#24292e), so code blocks blend into the
    // stream instead of punching out as a brighter island. Its token
    // palette is also brighter/more saturated, improving legibility.
    themes: ["github-light", "github-dark-default"],
    langs: EAGER_LANGS,
  }).then((hl) => {
    highlighterInstance = hl;
    return hl;
  });
  return highlighterPromise;
}

function currentTheme(): BundledTheme {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "github-dark-default" : "github-light";
  }
  return "github-dark-default";
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function extractLanguage(className?: string): string {
  const match = /language-(\w+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function isFencedCode(className?: string): boolean {
  return /language-\w+/.test(className ?? "");
}

/** Minimal HTML entity escaping for the safe fallback path. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Copy button ───────────────────────────────────────────────────────

/** Collapsed height of a fenced code block before the user clicks 展开
 *  (taller blocks preview-scroll inside this box). */
const CODE_COLLAPSE_MAX_PX = 360;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
      )}
      title={t("chatStream.copyCode")}
    >
      {copied ? (<><IconCheck size={10} /> {t("common.copied")}</>) : (<><IconCopy size={10} /> {t("common.copy")}</>)}
    </button>
  );
}

// ── Rehype plugin: inline skill/command highlighting ──────────────────
//
// react-markdown v10 does NOT support a `text` component override — text
// nodes are passed through as raw strings by hast-util-to-jsx-runtime. So
// we intercept at the hast level: this plugin walks the tree, finds `text`
// nodes that contain `/skillName` references (outside code/pre), and
// replaces them with styled `<span class="skill-pill-inline">` element
// nodes. react-markdown then renders these normally.
//
// This is the standard unified/rehype pattern — the same approach used by
// rehype-katex, rehype-autolink-headings, etc.

/** Minimal hast node shape — we only need these three fields. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** True when the element is a `<code>` or `<pre>` — text inside should
 *  never be linkified. */
function isCodeElement(node: HastNode): boolean {
  return node.type === "element" && (node.tagName === "code" || node.tagName === "pre");
}

/** Split a text value by skill/command references, producing an array of
 *  text nodes and styled span elements that mirror the composer's skill
 *  pill (✦ glyph + /name in accent color). Returns [] when nothing matched,
 *  so the caller can keep the original node untouched. */
function transformTextBySkills(value: string, skillRe: RegExp): HastNode[] {
  skillRe.lastIndex = 0;
  const nodes: HastNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = skillRe.exec(value)) !== null) {
    const start = m.index;
    const name = m[1];
    if (start > last) {
      nodes.push({ type: "text", value: value.slice(last, start) });
    }
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { className: ["skill-pill-inline"], title: `Skill: /${name}` },
      children: [
        {
          type: "element",
          tagName: "span",
          properties: { className: ["skill-pill-inline-glyph"], ariaHidden: true },
          children: [{ type: "text", value: "✦" }],
        },
        { type: "text", value: `/${name}` },
      ],
    });
    last = start + m[0].length;
  }
  if (nodes.length === 0) return []; // no match — caller keeps original
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

/** Recursively walk hast children, replacing text nodes (outside code/pre)
 *  with skill-highlighted element nodes. Returns a new children array. */
function walkAndTransform(children: HastNode[], skillRe: RegExp, inCode: boolean): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && !inCode && child.value && child.value.includes("/")) {
      const transformed = transformTextBySkills(child.value, skillRe);
      if (transformed.length > 0) {
        out.push(...transformed);
      } else {
        out.push(child);
      }
    } else if (child.type === "element" && child.children) {
      out.push({
        ...child,
        children: walkAndTransform(child.children, skillRe, inCode || isCodeElement(child)),
      });
    } else if (child.children) {
      out.push({ ...child, children: walkAndTransform(child.children, skillRe, inCode) });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Create a rehype plugin that highlights inline skill/command references.
 *  The plugin closes over `skillRe` so it can be recreated when the set of
 *  known skills changes. */
function rehypeSkillInline(skillRe: RegExp) {
  return function skillInlinePlugin() {
    return function transformer(tree: HastNode) {
      if (tree.children) {
        tree.children = walkAndTransform(tree.children, skillRe, false);
      }
    };
  };
}

// ── Rehype plugin: inline @-file mention pills (issue #22) ────────────
//
// Same hast-level strategy as the skill pill above: user messages whose
// composer pick kept a lightweight `@<basename>` marker render that marker
// as a styled span (hover title = full path). The name→path map comes from
// the message's inlined file attachments, so only markers that actually
// reference a file of THIS message get pillified — a stray `@foo` in
// hand-typed prose stays plain text.

/** Split a text value by `@<name>` file markers, producing text nodes and
 *  styled span elements. Returns [] when nothing matched. */
function transformTextByFileMentions(
  value: string,
  fileRe: RegExp,
  titleByMarker: Map<string, string>,
): HastNode[] {
  fileRe.lastIndex = 0;
  const nodes: HastNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(value)) !== null) {
    const start = m.index;
    const marker = m[0];
    const title = titleByMarker.get(marker);
    if (title === undefined) continue; // defensive — regex only matches known names
    if (start > last) {
      nodes.push({ type: "text", value: value.slice(last, start) });
    }
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { className: ["file-pill-inline"], title },
      children: [{ type: "text", value: marker }],
    });
    last = start + marker.length;
  }
  if (nodes.length === 0) return [];
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

/** Recursive walk mirroring walkAndTransform, but for file-mention pills
 *  (the per-match title map makes a shared walker awkward). */
function walkAndTransformFileMentions(
  children: HastNode[],
  fileRe: RegExp,
  titleByMarker: Map<string, string>,
  inCode: boolean,
): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && !inCode && child.value && child.value.includes("@")) {
      const transformed = transformTextByFileMentions(child.value, fileRe, titleByMarker);
      if (transformed.length > 0) {
        out.push(...transformed);
      } else {
        out.push(child);
      }
    } else if (child.type === "element" && child.children) {
      out.push({
        ...child,
        children: walkAndTransformFileMentions(
          child.children,
          fileRe,
          titleByMarker,
          inCode || isCodeElement(child),
        ),
      });
    } else if (child.children) {
      out.push({ ...child, children: walkAndTransformFileMentions(child.children, fileRe, titleByMarker, inCode) });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Create a rehype plugin that pillifies inline `@<name>` file-mention
 *  markers. Closes over the regex + title map, recreated when the set of
 *  inlined files changes. */
function rehypeFileInline(fileRe: RegExp, titleByMarker: Map<string, string>) {
  return function fileInlinePlugin() {
    return function transformer(tree: HastNode) {
      if (tree.children) {
        tree.children = walkAndTransformFileMentions(tree.children, fileRe, titleByMarker, false);
      }
    };
  };
}

// ── react-markdown component overrides ────────────────────────────────

/**
 * Project root of the session whose message is being rendered — consumed by
 * the `a`/`img` overrides to resolve local file links. A context (not a
 * `buildComponents` argument) keeps the components object identity stable
 * across project switches, so code-block collapse state survives.
 */
const MarkdownProjectContext = createContext<string | null>(null);

/**
 * Absolute directory that relative local paths in links/images resolve
 * against. Set ONLY by contexts that know the source file's location (the
 * IDE's .md preview passes the previewed file's directory); chat leaves it
 * null, so relative refs keep the search-based FileLink resolution and local
 * images render as chips instead of inline `<img>`.
 */
const MarkdownBaseDirContext = createContext<string | null>(null);

/** data-URL cache for local images referenced by markdown. Promise-valued so
 *  concurrent renders of the same path share one IPC read; failures are
 *  cached too (as "") so a re-render doesn't spam the backend. FIFO-capped so
 *  a long session can't grow it unboundedly. Cached data URLs may go stale if
 *  the image file is rewritten in place — acceptable for a preview pane
 *  (re-opening the file reloads the pane but reuses bytes; remount of the app
 *  clears). */
const mdImageDataUrls = new Map<string, Promise<string>>();
const MD_IMAGE_CACHE_CAP = 60;

function loadMarkdownImageDataUrl(filePath: string): Promise<string> {
  const cached = mdImageDataUrls.get(filePath);
  if (cached) return cached;
  const promise = api.file
    .readBinary({ filePath })
    .then(({ dataUrl }) => dataUrl)
    .catch(() => "");
  mdImageDataUrls.set(filePath, promise);
  if (mdImageDataUrls.size > MD_IMAGE_CACHE_CAP) {
    const oldest = mdImageDataUrls.keys().next().value;
    if (oldest !== undefined) mdImageDataUrls.delete(oldest);
  }
  return promise;
}

/**
 * Inline local image for markdown contexts that HAVE a base directory (the
 * IDE's .md preview). Loads bytes via `file.readBinary` (main-side path guard
 * applies) and renders a real `<img>` from a data: URL — the webview cannot
 * fetch drive-letter/relative URLs directly. Loading shows the alt text with
 * a spinner; a failed read (missing file / outside known roots) degrades to
 * the clickable file chip.
 */
function MarkdownLocalImage({
  filePath,
  projectPath,
  alt,
}: {
  filePath: string;
  projectPath: string | null;
  alt: string;
}) {
  // null = loading, "" = failed, otherwise a data: URL.
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    loadMarkdownImageDataUrl(filePath).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (dataUrl === null) {
    return (
      <span className="my-[var(--chat-md-gap-xs)] inline-flex items-center gap-1 align-middle text-content-subtle [font-size:var(--chat-fs-xs)]">
        <IconLoader2 size={12} className="animate-spin" />
        {alt}
      </span>
    );
  }
  if (!dataUrl) {
    return (
      <span className="my-[var(--chat-md-gap-xs)] inline-flex max-w-full items-center gap-1 rounded border border-edge/60 bg-surface-muted/60 px-1.5 py-0.5 align-middle text-content-muted [font-size:var(--chat-fs-xs)]">
        <FileLink
          token={filePath}
          projectPath={projectPath}
          display={alt ? <span className="text-info underline">{alt}</span> : undefined}
        />
      </span>
    );
  }
  return (
    <span className="my-[var(--chat-md-gap-xs)] inline-block align-middle">
      <ImageWithPreview
        src={dataUrl}
        alt={alt}
        maxThumbnailHeight={420}
        maxThumbnailWidth={720}
      />
    </span>
  );
}

/**
 * Preserve local-file paths in link/image URLs. react-markdown's default
 * sanitizer treats `D:/...` as an unknown protocol (`d`) and `file://` as
 * unsafe, rewriting BOTH to "" — the anchor then carries `href=""` and
 * clicking it re-opens the app's own origin (dev: http://localhost:5173/)
 * in the system browser via the main window's window-open guard. Web URLs
 * keep the default behavior (http/https/mailto preserved, `javascript:` etc.
 * stripped).
 */
function urlTransform(url: string): string {
  if (isLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
}

/**
 * Vestigial: formerly consumed by the `text` component override (now removed)
 * to skip path linkification inside code. Code-context skipping now happens
 * in the `rehypeSkillInline` plugin via {@link isCodeElement}. Kept because
 * the `code`/`pre` overrides below still wrap children in a Provider (harmless).
 */
const CodeContext = createContext(false);
const useInCode = () => useContext(CodeContext);

// Fenced code block: highlighted via shiki with copy button + lang label.
// Falls back to plain code when highlighting fails (unknown language etc.).
function ShikiCodeBlock({
  className,
  rawCode,
  childProps,
}: {
  className: string;
  rawCode: string;
  childProps?: { className?: string; children?: unknown };
}) {
  const lang = resolveLang(extractLanguage(className));

  // Lazy-init highlighter on first encounter of a fenced block.
  const [ready, setReady] = useState(!!highlighterInstance);
  useMemo(() => {
    if (!highlighterInstance) {
      ensureHighlighter().then(() => setReady(true));
    }
  }, []);

  const html = useMemo(() => {
    if (!rawCode) return null;

    // Theme is part of the cache key so a theme switch (light↔dark, or a
    // theme-name change) invalidates stale HTML and re-highlights instead
    // of serving the wrong palette.
    const theme = currentTheme();
    const key = codeCacheKey(rawCode, lang, theme);
    // Cache hit?
    const cached = getCodeHtml(key);
    if (cached) return { __html: cached, key };

    // Highlighter ready?
    if (highlighterInstance) {
      // Helper: attempt highlighting with a given language, returning null
      // on any error instead of throwing.
      const tryHighlight = (tryLang: string): string | null => {
        try {
          return highlighterInstance!.codeToHtml(rawCode, {
            lang: tryLang,
            theme,
            transformers: [transformerNotationDiff()],
          });
        } catch {
          return null; // Language not found or other error — caller handles.
        }
      };

      // First attempt: requested language.
      let highlighted = tryHighlight(lang);
      // Fallback: "text" (always available, plain monospace).
      if (!highlighted && lang !== "text") {
        highlighted = tryHighlight("text");
      }
      if (highlighted) {
        setCodeHtml(key, highlighted);
        return { __html: highlighted, key };
      }
      // Both attempts failed — cache a safe placeholder.
      setCodeHtml(key, `<pre class="shiki fallback"><code>${escapeHtml(rawCode)}</code></pre>`);
    }

    return null; // Not ready yet or highlight failed — show raw text.
  }, [rawCode, lang, ready]);

  // Long code blocks are collapsed to a max-height preview with a 展开
  // overlay; clicking it (or the 收起 header button once expanded) toggles
  // full height. `clippable` is re-measured only while collapsed, so
  // streaming growth stays accurate and an expanded block's unbounded
  // scrollHeight never accidentally un-clips it.
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [clippable, setClippable] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    setClippable(el.scrollHeight > el.clientHeight + 1);
  }, [rawCode, lang, ready, html, expanded]);

  return (
    <pre className="my-[var(--chat-md-gap-md)] overflow-hidden rounded-lg border border-edge/60 bg-surface-muted/60">
      <div className="flex items-center justify-between gap-2 border-b border-edge/60 bg-surface-muted/40 px-2 py-0.5 text-content-subtle [font-size:var(--chat-fs-xxs)]">
        <span className="truncate font-mono">{lang}</span>
        <span className="flex shrink-0 items-center gap-1">
          {clippable && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover/60 hover:text-content-muted"
              title={t("chatStream.code.collapse")}
            >
              <IconChevronUp size={10} /> {t("chatStream.code.collapse")}
            </button>
          )}
          <CopyButton text={rawCode.replace(/\n$/, "")} />
        </span>
      </div>
      <div className="relative">
        <div
          ref={bodyRef}
          className="overflow-auto"
          style={{ maxHeight: expanded ? undefined : CODE_COLLAPSE_MAX_PX }}
        >
          {html ? (
            <div className="px-3 py-2 [font-size:var(--chat-fs-xs)]" dangerouslySetInnerHTML={html} />
          ) : (
            <code className="block px-3 py-2 font-mono leading-relaxed text-content [font-size:var(--chat-fs-xs)]">
              {childProps?.children as React.ReactNode}
            </code>
          )}
        </div>
        {clippable && !expanded && (
          <>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-muted/90 to-transparent" />
            <button
              onClick={() => setExpanded(true)}
              className="absolute bottom-1.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge bg-surface px-2.5 py-0.5 text-content-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-content"
              title={t("chatStream.code.expand")}
            >
              <IconChevronDown size={12} /> {t("chatStream.code.expand")}
            </button>
          </>
        )}
      </div>
    </pre>
  );
}

/**
 * Build the react-markdown component overrides. Skill/command highlighting
 * is NOT done here — it's handled by the `rehypeSkillInline` rehype plugin
 * (see above), which operates at the hast level because react-markdown v10
 * does not call a `text` component override.
 */
function buildComponents(): Components {
  return {
  // Inline code - styled inline, no highlighting needed. Paths inside are
  // linkified when a project root is known — the rehype plugin skips code
  // elements by design, and model-emitted paths are most often wrapped in
  // backticks, so this is the highest-traffic spot for click-to-open.
  code({ className, children }) {
    const isInline = !isFencedCode(className);
    if (isInline) {
      const projectPath = useContext(MarkdownProjectContext);
      let content: React.ReactNode = children;
      if (projectPath) {
        const segs = splitTextByPathTokens(extractText(children));
        if (segs.some((s) => s.kind === "path")) {
          content = segs.map((s, i) =>
            s.kind === "text" ? (
              s.text
            ) : (
              <FileLink key={i} token={s.token} line={s.line} column={s.column} projectPath={projectPath} />
            ),
          );
        }
      }
      return (
        <code className="rounded bg-surface-muted/80 px-1 py-0.5 font-mono [font-size:var(--chat-fs-xs)] [color:var(--code-fg)]">
          <CodeContext.Provider value={true}>{content}</CodeContext.Provider>
        </code>
      );
    }
    return <code className="font-mono"><CodeContext.Provider value={true}>{children}</CodeContext.Provider></code>;
  },

  // Dispatch placeholder spans produced by `rehypePathInline` to FileLink;
  // every other span (katex internals, skill/file pills) passes through
  // untouched. `node` is react-markdown's hast reference and must be kept
  // out of the DOM spread.
  span({ node, className, children, ...rest }) {
    const projectPath = useContext(MarkdownProjectContext);
    if (typeof className === "string" && className.split(/\s+/).includes(FILE_PATH_LINK_CLASS)) {
      const props = rest as Record<string, unknown>;
      const token = props["data-token"];
      if (typeof token === "string" && token) {
        const line = Number(props["data-line"]);
        const column = Number(props["data-column"]);
        return (
          <FileLink
            token={token}
            projectPath={projectPath}
            line={Number.isFinite(line) && line > 0 ? line : undefined}
            column={Number.isFinite(column) && column > 0 ? column : undefined}
          />
        );
      }
    }
    return (
      <span className={className} {...rest}>
        {children}
      </span>
    );
  },

  // Fenced code block: highlighted via shiki with copy button + lang label,
  // or custom-rendered for special interactive formats (e.g. scheduled_task_proposal).
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (child as { props?: { className?: string; children?: unknown } })?.props;
    const className = childProps?.className ?? "";
    const rawCode = extractText(childProps?.children);
    const rawLang = extractLanguage(className);
    if (rawLang === "scheduled_task_proposal") {
      return <ScheduledTaskApprovalCard rawJson={rawCode} />;
    }
    if (rawLang === "mermaid") {
      return <MermaidBlock rawCode={rawCode} className={className} />;
    }
    return <ShikiCodeBlock className={className} rawCode={rawCode} childProps={childProps} />;
  },

  a({ children, href }) {
    const projectPath = useContext(MarkdownProjectContext);
    const baseDir = useContext(MarkdownBaseDirContext);
    const raw = (href ?? "").trim();
    // Sanitized-away href (e.g. `javascript:`): an `<a href="">` would navigate
    // the app's own origin on click — render a non-navigating span instead.
    if (!raw) {
      return <span className="text-info underline">{children}</span>;
    }
    // Local file path (drive-letter / file:// / scheme-less): resolve and open
    // in the IDE instead of navigating — see fileLink.ts. In a base-dir
    // context (md preview) relative refs resolve against the previewed file's
    // directory so the exact sibling file opens instead of a search match.
    if (isLocalFileHref(raw)) {
      const path = fileHrefToPath(raw);
      const token =
        baseDir && !isAbsolutePath(path) ? resolveRelativePath(baseDir, path) : path;
      return (
        <FileLink
          token={token}
          projectPath={projectPath}
          asLink
          display={<span className="text-info underline hover:opacity-80">{children}</span>}
        />
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-info underline hover:text-info">
        {children}
      </a>
    );
  },
  // Local-path images can't be loaded by the webview (drive-letter "scheme"
  // / file:// / relative refs are not fetchable). With a base directory (md
  // preview) resolve against it and render inline via file.readBinary; in
  // chat (no base dir) render a clickable file chip that opens the IDE's
  // image preview. Web images pass through untouched.
  img({ src, alt }) {
    const projectPath = useContext(MarkdownProjectContext);
    const baseDir = useContext(MarkdownBaseDirContext);
    const raw = (src ?? "").trim();
    if (isLocalFileHref(raw)) {
      const path = fileHrefToPath(raw);
      const absolute =
        baseDir && !isAbsolutePath(path) ? resolveRelativePath(baseDir, path) : path;
      if (baseDir) {
        return (
          <MarkdownLocalImage filePath={absolute} projectPath={projectPath ?? null} alt={alt ?? ""} />
        );
      }
      return (
        <span className="my-[var(--chat-md-gap-xs)] inline-flex max-w-full items-center gap-1 rounded border border-edge/60 bg-surface-muted/60 px-1.5 py-0.5 align-middle text-content-muted [font-size:var(--chat-fs-xs)]">
          <FileLink
            token={absolute}
            projectPath={projectPath}
            display={alt ? <span className="text-info underline">{alt}</span> : undefined}
          />
        </span>
      );
    }
    if (!src) return null;
    return (
      <span className="my-[var(--chat-md-gap-xs)] inline-block align-middle">
        <ImageWithPreview
          src={src}
          alt={alt ?? ""}
          maxThumbnailHeight={420}
          maxThumbnailWidth={720}
        />
      </span>
    );
  },
  ul({ children }) {
    return <ul className="my-[var(--chat-md-gap-sm)] list-disc space-y-[var(--chat-md-gap-xs)] pl-5 text-content-muted marker:text-content-subtle">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-[var(--chat-md-gap-sm)] list-decimal space-y-[var(--chat-md-gap-xs)] pl-5 text-content-muted marker:text-content-subtle">{children}</ol>;
  },
  blockquote({ children }) {
    return <blockquote className="my-[var(--chat-md-gap-md)] border-l-2 border-edge pl-3 text-content-muted">{children}</blockquote>;
  },
  hr() {
    // Model-emitted "---". Without an override the browser default renders
    // (border: 1px inset + 0.5em margins) — a faint double line with
    // unpredictable spacing that reads as an unexplained gap on dark surfaces.
    return <hr className="my-[var(--chat-md-gap-md)] border-0 border-t border-edge" />;
  },
  // Bold is full --content: in paragraphs that matches the body color (weight
  // alone marks emphasis); in muted contexts (lists / tables / blockquotes) the
  // extra brightness keeps emphasized words legible. Dark chat lists soften
  // that jump via the `.dark .chat-md li strong` rule in styles.css — see the
  // "Chat markdown list lift" block there for the rationale.
  strong({ children }) {
    return <strong className="text-content">{children}</strong>;
  },
  // Table sizing is content-first: `w-full` + auto layout squeezed text-heavy
  // columns to per-word vertical strips on narrow panes (and stretched sparse
  // tables to full width). max-content lets every column take its natural
  // width, min-width:100% keeps sparse tables filling the column (previous
  // look), and the per-cell max-width cap makes long prose wrap at a readable
  // measure instead of rendering one enormous unbroken line. The overflow-x-auto
  // wrapper scrolls whatever still exceeds the pane.
  table({ children }) {
    return (
      <div className="my-[var(--chat-md-gap-md)] overflow-x-auto">
        <table className="[width:max-content] [min-width:100%] border-collapse [font-size:var(--chat-fs-sm)]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="max-w-[32ch] border border-edge bg-surface-muted/50 px-2 py-1 text-left font-semibold text-content">{children}</th>;
  },
  td({ children }) {
    return <td className="max-w-[32ch] border border-edge px-2 py-1 text-content-muted">{children}</td>;
  },
  h1({ children }) {
    return <h1 className="mb-[var(--chat-md-gap-md)] mt-[var(--chat-md-gap-lg)] font-bold text-content [font-size:var(--chat-fs-lg)]">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-[var(--chat-md-gap-sm)] mt-[var(--chat-md-gap-lg)] font-bold text-content [font-size:var(--chat-font-size)]">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-[var(--chat-md-gap-xs)] mt-[var(--chat-md-gap-md)] font-semibold text-content [font-size:var(--chat-font-size)]">{children}</h3>;
  },
  };
}

const STATIC_MARKDOWN_COMPONENTS: Components = buildComponents();

export const Markdown = memo(function Markdown({
  children,
  projectPath,
  skillNames,
  inlineFiles,
  baseDir,
}: {
  children: string;
  /** Project root — bare file paths in prose (and inline code) that fall
   *  under it render as clickable FileLinks (unique match opens directly,
   *  same-name matches open a candidate picker, `:line[:col]` suffixes
   *  jump to the position). Contexts without a root keep plain text. */
  projectPath?: string | null;
  /** Names of skills/commands that should be highlighted when they appear as
   *  `/name` in this text. Passed to the `rehypeSkillInline` plugin which
   *  transforms matching text nodes at the hast level. */
  skillNames?: ReadonlyArray<string>;
  /** Files referenced inline via `@<name>` markers in this text (issue #22).
   *  Matching markers render as pills titled with the file's full path;
   *  names are matched whole (with a boundary lookahead), so e-mail-style
   *  `user@host` text is left alone unless `host` is literally one of these
   *  file names. */
  inlineFiles?: ReadonlyArray<{ name: string; filePath: string }>;
  /** Absolute directory that relative local paths in links/images resolve
   *  against (the previewed .md file's directory). When set, local images
   *  render INLINE (loaded via file.readBinary) and relative links open the
   *  exact sibling file; leave unset for chat output. */
  baseDir?: string | null;
}) {
  // Build a single regex matching any known `/skillName` at its boundary.
  // Sorted longest-first so a skill named `pdf` doesn't shadow `pdf-generator`.
  const skillRe = useMemo(() => {
    if (!skillNames || skillNames.length === 0) return null;
    const escaped = skillNames
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);
    return new RegExp(`/(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
  }, [skillNames]);
  // Same construction for `@<fileName>` markers (issue #22), plus the
  // marker→full-path title map the pill hover shows. The match includes the
  // leading `@` so the map keys are the literal markers found in the text.
  const fileMention = useMemo(() => {
    if (!inlineFiles || inlineFiles.length === 0) return null;
    const escaped = inlineFiles
      .map((f) => f.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);
    const re = new RegExp(`@(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
    const titleByMarker = new Map<string, string>();
    for (const f of inlineFiles) titleByMarker.set(`@${f.name}`, f.filePath);
    return { re, titleByMarker };
  }, [inlineFiles]);
  // rehype-katex is always active; the skill-inline and file-mention plugins
  // are added only when there is something to highlight. Recreated when the
  // underlying regex/map changes, so react-markdown re-parses. The path
  // plugin needs a project root to resolve against — contexts without one
  // (GitHub panel, unopened views) keep plain text.
  const rehypePlugins = useMemo(() => {
    if (!skillRe && !fileMention && !projectPath) return DEFAULT_REHYPE_PLUGINS;
    return [
      rehypeKatex,
      ...(skillRe ? [rehypeSkillInline(skillRe)] : []),
      ...(fileMention ? [rehypeFileInline(fileMention.re, fileMention.titleByMarker)] : []),
      ...(projectPath ? [rehypePathInline()] : []),
    ];
  }, [skillRe, fileMention, projectPath]);
  // Block margins + line-height here are density-driven (--chat-md-gap-* /
  // --chat-md-leading, see the chat-density section in styles.css) so the
  // 对话紧凑度 setting shapes the reply body itself, not just the gaps
  // between message rows.
  //
  // Flush edges: the first/last CHILD's own margin is zeroed so this block's
  // boundary sits flush with whatever container gap surrounds it. Without
  // this, a first/last <p> (or list/code block) margin collapses OUT of this
  // div — it has no padding/border/BFC — and max()-collapses with the
  // container's row/block gap, so identical seams render at different heights
  // depending on where the block boundary falls. Internal paragraph margins
  // are untouched; the container alone controls the outer rhythm.
  return (
    <div
      className="chat-md break-words text-content [font-size:var(--chat-font-size)] [line-height:var(--chat-md-leading)] [font-weight:var(--chat-font-weight)] [&>p]:my-[var(--chat-md-gap-sm)] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
    >
      <MarkdownProjectContext.Provider value={projectPath ?? null}>
        <MarkdownBaseDirContext.Provider value={baseDir ?? null}>
          <ReactMarkdown
            remarkPlugins={DEFAULT_REMARK_PLUGINS}
            rehypePlugins={rehypePlugins}
            urlTransform={urlTransform}
            components={STATIC_MARKDOWN_COMPONENTS}
          >
            {children}
          </ReactMarkdown>
        </MarkdownBaseDirContext.Provider>
      </MarkdownProjectContext.Provider>
    </div>
  );
});
