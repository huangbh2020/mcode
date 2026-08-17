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
import { memo, useState, useMemo, createContext, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconCopy } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";
import { codeCacheKey, getCodeHtml, setCodeHtml } from "@renderer/lib/markdownCache.js";

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

// ── react-markdown component overrides ────────────────────────────────

/**
 * Vestigial: formerly consumed by the `text` component override (now removed)
 * to skip path linkification inside code. Code-context skipping now happens
 * in the `rehypeSkillInline` plugin via {@link isCodeElement}. Kept because
 * the `code`/`pre` overrides below still wrap children in a Provider (harmless).
 */
const CodeContext = createContext(false);
const useInCode = () => useContext(CodeContext);

/**
 * Build the react-markdown component overrides. Skill/command highlighting
 * is NOT done here — it's handled by the `rehypeSkillInline` rehype plugin
 * (see above), which operates at the hast level because react-markdown v10
 * does not call a `text` component override.
 */
function buildComponents(): Components {
  return {
  // Inline code - styled inline, no highlighting needed.
  code({ className, children }) {
    const isInline = !isFencedCode(className);
    if (isInline) {
      return (
        <code className="rounded bg-surface-muted/80 px-1 py-0.5 font-mono [font-size:var(--chat-fs-xs)] [color:var(--code-fg)]">
          <CodeContext.Provider value={true}>{children}</CodeContext.Provider>
        </code>
      );
    }
    return <code className="font-mono"><CodeContext.Provider value={true}>{children}</CodeContext.Provider></code>;
  },

  // Fenced code block: highlighted via shiki with copy button + lang label.
  // Falls back to plain code when highlighting fails (unknown language etc.).
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (child as { props?: { className?: string; children?: unknown } })?.props;
    const className = childProps?.className ?? "";
    const rawCode = extractText(childProps?.children);
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

    return (
      <pre className="my-[var(--chat-md-gap-md)] overflow-hidden rounded-lg border border-edge/60 bg-surface-muted/60">
        <div className="flex items-center justify-between border-b border-edge/60 bg-surface-muted/40 px-2 py-0.5 text-content-subtle [font-size:var(--chat-fs-xxs)]">
          <span className="font-mono">{lang}</span>
          <CopyButton text={rawCode.replace(/\n$/, "")} />
        </div>
        {html ? (
          <div className="overflow-x-auto px-3 py-2 [font-size:var(--chat-fs-xs)]" dangerouslySetInnerHTML={html} />
        ) : (
          <code className="block overflow-x-auto px-3 py-2 font-mono leading-relaxed text-content [font-size:var(--chat-fs-xs)]">
            {childProps?.children as React.ReactNode}
          </code>
        )}
      </pre>
    );
  },

  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-info underline hover:text-info">
        {children}
      </a>
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
  // Bold stays at the brightest content color even inside muted contexts
  // (lists / tables / blockquotes all inherit --content-muted), so emphasized
  // words still pop against the dimmer surrounding text.
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

export const Markdown = memo(function Markdown({
  children,
  projectPath,
  skillNames,
}: {
  children: string;
  /** Project root — reserved for future inline file-path linkification.
   *  Currently unused (the feature was in the dead `text` override; see the
   *  rehype plugin section for the replacement strategy). */
  projectPath?: string | null;
  /** Names of skills/commands that should be highlighted when they appear as
   *  `/name` in this text. Passed to the `rehypeSkillInline` plugin which
   *  transforms matching text nodes at the hast level. */
  skillNames?: ReadonlyArray<string>;
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
  const components = useMemo(() => buildComponents(), []);
  // rehype-katex is always active; the skill-inline plugin is added only when
  // we have known skill names to highlight. Recreated when `skillRe` changes
  // (i.e. when the skills list updates), so react-markdown re-parses.
  const rehypePlugins = useMemo(
    () => (skillRe ? [rehypeKatex, rehypeSkillInline(skillRe)] : [rehypeKatex]),
    [skillRe],
  );
  // Block margins + line-height here are density-driven (--chat-md-gap-* /
  // --chat-md-leading, see the chat-density section in styles.css) so the
  // 对话紧凑度 setting shapes the reply body itself, not just the gaps
  // between message rows.
  return (
    <div
      className="break-words text-content [font-size:var(--chat-font-size)] [line-height:var(--chat-md-leading)] [font-weight:var(--chat-font-weight)] [&>p]:my-[var(--chat-md-gap-sm)] [&:first-child]:mt-0 [&:last-child]:mb-0"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
