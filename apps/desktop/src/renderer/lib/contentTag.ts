/**
 * Content-tag model - a pasted chunk that's been promoted from "inline text"
 * to a small chip displayed above the textarea.
 *
 * Why: long pastes (logs, stack traces, file contents) bury the input area
 * and crowd out the visible message stream. Promoting them to tags keeps the
 * composer compact and lets the user click a chip to inspect or remove the
 * payload before sending.
 *
 * State is owned by the composer (ChatPane); it is intentionally not in the
 * Zustand store because it's ephemeral per-turn UI state, not session data.
 */
import type { PickedElement } from "@contracts/ipc";
import { browserUuid } from "@renderer/lib/uuid.js";

/** Display char count for a tag's preview text. Single line, whitespace
 *  collapsed; an ellipsis is appended if the original was longer. */
export const TAG_PREVIEW_CHARS = 24;

/** Custom DataTransfer MIME type used by the file-tree → composer drag.
 *  Using a custom type (instead of text/plain) ensures only OUR file nodes
 *  trigger a drop — external text/image drags are ignored by the composer. */
export const FILE_DRAG_MIME = "application/x-file-path";

/** Pasting a single-line shorter than this is left inline in the textarea
 *  (no chip). Anything over this OR a paste with more than
 *  {@link TAG_THRESHOLD_LINES} lines becomes a tag. */
export const TAG_THRESHOLD_CHARS = 200;

/** Image file extensions we can preview as a data-URL `<img>` in the popover /
 *  chip. Mirrors the editor's `isImage()` set (FileEditor.tsx) so composer
 *  chips, message attachment cards, and the IDE editor all agree on what
 *  counts as an image. */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".tif",
  ".tiff",
  ".avif",
]);

/** True if `path` has a previewable image extension (case-insensitive). */
export function isImageFilePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** A paste spanning more than this many lines is promoted to a tag even if
 *  it's short — long logs / stack traces get chipped regardless of char
 *  count. A 2-3 line snippet stays inline so the user isn't interrupted
 *  for ordinary multi-line pastes. */
export const TAG_THRESHOLD_LINES = 3;

/** Source of the tag: "paste" for bulky clipboard content, "file" for a
 *  file dragged in from the file tree (path reference only - no content
 *  is read), "element" for a DOM element picked from the embedded browser
 *  (selector + outerHTML inlined so the model can see it). */
export type ContentTagKind = "paste" | "file" | "element";

/** One content tag. `id` is the React key + removal handle. `content` is the
 *  full pasted text (for paste) or the `@path` reference string (for file),
 *  sent verbatim on Send. `preview` is for chip display. `filePath` is only
 *  set for file tags (the absolute path of the dragged file). */
export interface ContentTag {
  id: string;
  kind: ContentTagKind;
  preview: string;
  content: string;
  /** Absolute path of the dragged file. Only set when kind === "file". */
  filePath?: string;
}

/** Decide whether a pasted string should become a tag rather than be
 *  inserted into the textarea. Empty / whitespace-only is never a tag.
 *  Promote only when the paste is genuinely bulky: over the char threshold
 *  OR spanning more than the line threshold. Short multi-line snippets
 *  (2-3 lines) stay inline so ordinary pastes aren't interrupted. */
export function shouldPromoteToTag(text: string, thresholdChars: number = TAG_THRESHOLD_CHARS): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > thresholdChars) return true;
  // Count lines: a string with N newlines has N+1 lines, but a trailing
  // newline (already trimmed away) shouldn't inflate the count.
  const lineCount = t.split("\n").length;
  return lineCount > TAG_THRESHOLD_LINES;
}

/** Build a ContentTag from a raw pasted string. Trims and collapses
 *  whitespace for the preview; the full content is preserved untouched. */
export function makeContentTag(text: string): ContentTag {
  const trimmed = text.trim();
  // Collapse internal whitespace so the preview fits on one chip line and
  // the chip width stays bounded. The full content is kept verbatim — that
  // is what gets sent to the SDK.
  const collapsed = trimmed.replace(/\s+/g, " ");
  const preview =
    collapsed.length > TAG_PREVIEW_CHARS
      ? collapsed.slice(0, TAG_PREVIEW_CHARS) + "…"
      : collapsed;
  return {
    id: cryptoRandomId(),
    kind: "paste",
    preview,
    content: trimmed,
  };
}

/** Build a ContentTag for a file dragged in from the file tree. Unlike paste
 *  tags, a file tag carries only a PATH reference (the agent reads the file
 *  itself via its tools) - no file content is loaded. `preview` is the base
 *  file name; `content` is the `@path` reference injected into the prompt.
 *
 *  `displayName` overrides the preview when the path's basename isn't
 *  user-meaningful — clipboard-pasted external files are materialized to a
 *  random temp path by main, so the card must show the ORIGINAL file name. */
export function makeFileTag(filePath: string, displayName?: string): ContentTag {
  // Derive a short display name from the last path segment (handles both /
  // and \ separators for cross-platform paths).
  const segs = (displayName ?? filePath).split(/[/\\]/);
  const name = segs[segs.length - 1] || filePath;
  const preview =
    name.length > TAG_PREVIEW_CHARS ? name.slice(0, TAG_PREVIEW_CHARS) + "…" : name;
  return {
    id: cryptoRandomId(),
    kind: "file",
    preview,
    content: `@${filePath}`,
    filePath,
  };
}

/** True for a file tag whose path is a previewable image. Used by TagPopover
 *  to render an `<img>` instead of the raw `@path` text, and by the chip to
 *  swap in a photo icon. */
export function isImageFile(tag: ContentTag): boolean {
  return tag.kind === "file" && !!tag.filePath && isImageFilePath(tag.filePath);
}

/** Build a ContentTag for a DOM element picked from the embedded browser. The
 *  selector + outerHTML + source URL are inlined into the prompt (delimited
 *  block, like paste) so the model can reason about the element directly.
 *  `preview` is a short selector + tag hint for the chip. */
export function makeElementTag(el: PickedElement): ContentTag {
  const preview =
    el.preview.length > TAG_PREVIEW_CHARS
      ? el.preview.slice(0, TAG_PREVIEW_CHARS) + "…"
      : el.preview;
  // Delimited block mirroring the paste format, but labeled as a page element
  // with its selector + source URL so the model knows exactly what it's seeing.
  const content = `--- 页面元素 (${el.selector}) ---\n来源: ${el.url}\n${el.outerHTML}\n--- end ---`;
  return {
    id: cryptoRandomId(),
    kind: "element",
    preview,
    content,
  };
}

/** Browser-safe UUID — delegates to the shared {@link browserUuid} helper. */
function cryptoRandomId(): string {
  return browserUuid();
}

/** Compose the final prompt string from the textarea text + all tags.
 *  Tags are appended so the model can clearly see "user typed X, plus these
 *  N attachments". Order: typed text first, then tags in array order.
 *
 *  - Paste tags become delimited content blocks (full text wrapped in
 *    `--- pasted content N ---` / `--- end ---` markers).
 *  - Element tags become delimited blocks too, but labeled as page elements
 *    (the content is already pre-formatted by makeElementTag - we emit it
 *    verbatim so the selector + URL + outerHTML stay together).
 *  - File tags become bare `@path` reference lines (one per line) - the
 *    agent reads the file itself via its tools, so no content is inlined. */
export function composePromptWithTags(
  text: string,
  tags: ReadonlyArray<ContentTag>,
): string {
  const textTrimmed = text.trim();
  if (tags.length === 0) return textTrimmed;
  // Separate paste blocks (delimited) from file refs (bare @path lines).
  // We preserve the original tag order by walking the array and emitting
  // each tag's contribution in sequence, joined by blank lines.
  const parts: string[] = [];
  let pasteIdx = 0;
  for (const tag of tags) {
    if (tag.kind === "file") {
      parts.push(tag.content); // already "@path"
    } else if (tag.kind === "element") {
      // Element content is already a fully-formatted delimited block.
      parts.push(tag.content);
    } else {
      pasteIdx += 1;
      parts.push(
        `--- pasted content ${pasteIdx} (${tag.content.length} chars) ---\n${tag.content}\n--- end ---`,
      );
    }
  }
  const tagBlock = parts.join("\n\n");
  return textTrimmed ? `${textTrimmed}\n\n${tagBlock}` : tagBlock;
}

/** Append file tags, skipping paths already present (by absolute filePath). */
export function appendUniqueFileTags(
  prev: ReadonlyArray<ContentTag>,
  filePaths: ReadonlyArray<string>,
): ContentTag[] {
  const seen = new Set(
    prev.filter((t) => t.kind === "file" && t.filePath).map((t) => t.filePath as string),
  );
  const next = [...prev];
  for (const p of filePaths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    next.push(makeFileTag(p));
  }
  return next;
}
