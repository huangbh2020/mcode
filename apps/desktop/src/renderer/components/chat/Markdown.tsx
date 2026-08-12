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
import { IconCheck, IconCopy } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";
import { codeCacheKey, getCodeHtml, setCodeHtml } from "@renderer/lib/markdownCache.js";
import { splitTextByPathTokens } from "@renderer/lib/fileLink.js";
import { FileLink } from "./FileLink.js";

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
      title="Copy code"
    >
      {copied ? (<><IconCheck size={10} /> copied</>) : (<><IconCopy size={10} /> copy</>)}
    </button>
  );
}

// ── react-markdown component overrides ────────────────────────────────

/**
 * Tracks whether the current text node is rendered inside a `code`/`pre`
 * context. When true, the `text` override skips path linkification - code
 * spans/blocks should render verbatim, not as clickable file links. Set by
 * the `code`/`pre` overrides below via the provider wrapping their children.
 */
const CodeContext = createContext(false);
const useInCode = () => useContext(CodeContext);

/**
 * Build the react-markdown component overrides. `projectPath` is threaded in
 * so the `text` override can resolve relative file paths mentioned in prose
 * against the owning project root. `skillRe` (optional) lets the `text`
 * override turn matching `/name` occurrences into styled inline skill pills.
 */
function buildComponents(
  projectPath: string | null | undefined,
  skillRe: RegExp | null,
): Components {
  return {
  // Inline code - styled inline, no highlighting needed.
  code({ className, children }) {
    const isInline = !isFencedCode(className);
    if (isInline) {
      return (
        <code className="rounded bg-surface-muted/80 px-1 py-0.5 font-mono [font-size:var(--chat-fs-xs)] text-content">
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
      <pre className="my-2 overflow-hidden rounded-lg border border-edge/60 bg-surface-muted/60">
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
    return <ul className="my-1.5 list-disc space-y-1 pl-5 text-content-muted marker:text-content-subtle">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1.5 list-decimal space-y-1 pl-5 text-content-muted marker:text-content-subtle">{children}</ol>;
  },
  blockquote({ children }) {
    return <blockquote className="my-2 border-l-2 border-edge pl-3 text-content-muted">{children}</blockquote>;
  },
  // Bold stays at the brightest content color even inside muted contexts
  // (lists / tables / blockquotes all inherit --content-muted), so emphasized
  // words still pop against the dimmer surrounding text.
  strong({ children }) {
    return <strong className="text-content">{children}</strong>;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse [font-size:var(--chat-fs-sm)]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-edge bg-surface-muted/50 px-2 py-1 text-left font-semibold text-content">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-edge px-2 py-1 text-content-muted">{children}</td>;
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-3 font-bold text-content [font-size:var(--chat-fs-lg)]">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-1.5 mt-3 font-bold text-content [font-size:var(--chat-font-size)]">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 mt-2 font-semibold text-content [font-size:var(--chat-font-size)]">{children}</h3>;
  },
  // Text override: scan leaf text nodes for file-path-like tokens AND inline
  // skill pills, wrapping matches in <FileLink> / styled <span> respectively.
  // Skipped inside code spans/blocks via CodeContext. Synchronous +
  // allocation-light (regex splits) so it's safe to run on every text node
  // during streaming; the expensive path (IPC resolution) happens only on
  // click inside <FileLink>.
  text({ children }) {
    if (useInCode()) return <>{children}</>;
    // react-markdown passes string children for text nodes; non-string
    // (numbers/elements) pass through untouched.
    if (typeof children !== "string") return <>{children}</>;
    const segs = splitTextByPathTokens(children);
    // No file links and no skills → render verbatim.
    if (
      (segs.length <= 1 && segs[0]?.kind === "text") &&
      (!skillRe || !skillRe.test(children))
    ) {
      // Reset lastIndex (test() advances it on a global regex).
      if (skillRe) skillRe.lastIndex = 0;
      return <>{children}</>;
    }
    if (skillRe) skillRe.lastIndex = 0;
    return (
      <>
        {segs.map((seg, i) =>
          seg.kind === "path" ? (
            <FileLink key={i} token={seg.token} projectPath={projectPath} />
          ) : (
            <SkillAwareText key={i} text={seg.text} skillRe={skillRe} />
          ),
        )}
      </>
    );
  },
  };
}

/** Render a plain-text segment, splitting out `/skillName` occurrences into
 *  styled inline pills when `skillRe` is provided. Plain text segments without
 *  a skill match render as a bare string (no wrapper span) to match the
 *  pre-skill behavior. */
function SkillAwareText({ text, skillRe }: { text: string; skillRe: RegExp | null }) {
  if (!skillRe) return <>{text}</>;
  skillRe.lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = skillRe.exec(text)) !== null) {
    const start = m.index;
    const name = m[1];
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span key={`s${idx++}`} className="skill-pill-inline" title={`Skill: /${name}`}>
        /{name}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (parts.length <= 1) return <>{parts.length ? parts[0] : text}</>;
  return <>{parts}</>;
}

export const Markdown = memo(function Markdown({
  children,
  projectPath,
  skillNames,
}: {
  children: string;
  /** Project root used to resolve relative/incomplete file paths mentioned in
   *  the prose. When omitted, only absolute paths under a known project can be
   *  opened (safe degradation). For chat this should be the SESSION's owning
   *  project path (not necessarily the active project) so backgrounded tabs
   *  resolve correctly. */
  projectPath?: string | null;
  /** Names of skills embedded inline in this text (from the rich-text
   *  composer). Matching `/name` occurrences are rendered as styled inline
   *  pills so they read the same in the stream as they did in the composer.
   *  Absent for assistant messages and plain-text user messages. */
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
  const components = useMemo(
    () => buildComponents(projectPath, skillRe),
    [projectPath, skillRe],
  );
  return (
    <div
      className="break-words text-content [font-size:var(--chat-font-size)] [line-height:var(--chat-line-height)] [font-weight:var(--chat-font-weight)] [&>p]:my-1.5 [&:first-child]:mt-0 [&:last-child]:mb-0"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
