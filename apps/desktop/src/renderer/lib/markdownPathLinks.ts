/**
 * Hast-level linkification of bare file paths in markdown prose.
 *
 * react-markdown v10 does NOT support a `text` component override, so free-
 * form prose paths (`src/a.ts`, `D:\x\b.md`, `FileEditor.tsx`) are turned
 * into placeholder spans at the hast layer — the same pattern as the
 * skill-pill and file-mention plugins in Markdown.tsx. The `span` component
 * override there dispatches on {@link FILE_PATH_LINK_CLASS} and renders a
 * FileLink, which resolves on click (unique match opens directly, same-name
 * matches open a candidate picker) and jumps to an absorbed `:line[:col]`.
 *
 * Text inside code/pre is never linkified here (mirrors those plugins);
 * inline-code paths are handled separately by the `code` override.
 */
import { splitTextByPathTokens } from "@renderer/lib/fileLink.js";

/** Minimal hast node shape — we only need these fields. */
export interface HastNode {
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

/** Class the Markdown.tsx `span` override dispatches on. */
export const FILE_PATH_LINK_CLASS = "file-path-link";

/**
 * Split a text value into plain-text nodes and file-path placeholder spans.
 * Returns [] when no path token matched, so the caller keeps the original
 * node untouched. Line/column data rides along as data- attributes so the
 * component override can hand them to FileLink for position jumps.
 */
export function transformTextByPaths(value: string): HastNode[] {
  const segs = splitTextByPathTokens(value);
  if (!segs.some((s) => s.kind === "path")) return [];
  return segs.map((s) =>
    s.kind === "text"
      ? { type: "text", value: s.text }
      : {
          type: "element",
          tagName: "span",
          properties: {
            className: [FILE_PATH_LINK_CLASS],
            dataToken: s.token,
            ...(s.line !== undefined ? { dataLine: String(s.line) } : {}),
            ...(s.column !== undefined ? { dataColumn: String(s.column) } : {}),
          },
          children: [{ type: "text", value: s.token }],
        },
  );
}

/** Recursively walk hast children, replacing text nodes (outside code/pre)
 *  with path-linkified element nodes. Returns a new children array. */
function walkAndTransformPaths(children: HastNode[], inCode: boolean): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && !inCode && child.value) {
      // Cheap pre-filter (mirrors the skill plugin): every path candidate
      // contains a slash, a backslash, or a dot — skip the regex work for
      // ordinary words.
      if (!/[\\/.]/.test(child.value)) {
        out.push(child);
        continue;
      }
      const transformed = transformTextByPaths(child.value);
      if (transformed.length > 0) {
        out.push(...transformed);
      } else {
        out.push(child);
      }
    } else if (child.type === "element" && child.children) {
      out.push({
        ...child,
        children: walkAndTransformPaths(child.children, inCode || isCodeElement(child)),
      });
    } else if (child.children) {
      out.push({ ...child, children: walkAndTransformPaths(child.children, inCode) });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Create a rehype plugin that linkifies bare file paths in prose text. */
export function rehypePathInline() {
  return function pathInlinePlugin() {
    return function transformer(tree: HastNode) {
      if (tree.children) {
        tree.children = walkAndTransformPaths(tree.children, false);
      }
    };
  };
}
