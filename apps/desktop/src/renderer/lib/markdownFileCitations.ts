/**
 * Hast-level restoration of the file-citation placeholders.
 *
 * `preprocessFileCitations` (lib/fileCitation.ts) takes each
 * `::zcode-file-citation{…}` out of the markdown source and leaves a
 * placeholder in its place. This plugin finds those placeholders in the
 * parsed text nodes and swaps each for a placeholder SPAN — the same
 * hand-off as `rehypePathInline` next door: the `span` component override in
 * Markdown.tsx dispatches on {@link FILE_CITATION_CLASS} and renders the
 * clickable chip, reading the citation by index from FileCitationContext.
 *
 * The span's child text is the placeholder itself, so a span that reaches
 * the override without a citation behind it (literal U+E000 text in a
 * document that was never preprocessed — the GitHub panel, the .md preview)
 * falls through and shows exactly what the source had.
 *
 * Code is not skipped here, unlike the sibling plugins: a placeholder can
 * only come from the preprocessor, which already decided that spot is not
 * code. Were that decision off by a little, a chip inside a code span beats
 * an invisible character.
 */
import { FILE_CITATION_PLACEHOLDER_RE } from "@renderer/lib/fileCitation.js";
import type { HastNode } from "@renderer/lib/markdownPathLinks.js";

/** Class the Markdown.tsx `span` override dispatches on. */
export const FILE_CITATION_CLASS = "file-citation";

/**
 * Split a text value by citation placeholders, producing text nodes and
 * placeholder spans whose `data-index` names the citation. Returns [] when
 * the value has none, so the caller keeps the original node untouched.
 */
function transformTextByPlaceholders(value: string): HastNode[] {
  FILE_CITATION_PLACEHOLDER_RE.lastIndex = 0;
  const nodes: HastNode[] = [];
  let last = 0;
  for (let m = FILE_CITATION_PLACEHOLDER_RE.exec(value); m !== null; m = FILE_CITATION_PLACEHOLDER_RE.exec(value)) {
    if (m.index > last) nodes.push({ type: "text", value: value.slice(last, m.index) });
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { className: [FILE_CITATION_CLASS], dataIndex: m[1] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (nodes.length === 0) return [];
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

/** Recursively walk hast children, replacing text nodes that carry a
 *  placeholder with placeholder-span nodes. Returns a new children array. */
function walkAndTransform(children: HastNode[]): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && child.value && child.value.includes("\uE000")) {
      const transformed = transformTextByPlaceholders(child.value);
      out.push(...(transformed.length > 0 ? transformed : [child]));
    } else if (child.children) {
      out.push({ ...child, children: walkAndTransform(child.children) });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Create the rehype plugin that restores citation placeholders. It closes
 *  over nothing — the citations travel in React context — so one instance
 *  serves every render. */
export function rehypeFileCitations() {
  return function fileCitationsPlugin() {
    return function transformer(tree: HastNode) {
      if (tree.children) {
        tree.children = walkAndTransform(tree.children);
      }
    };
  };
}
